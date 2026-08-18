import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parentPort } from "node:worker_threads";

import * as zstd from "@foxglove/wasm-zstd";
import { McapIndexedReader, McapWriter, type Metadata } from "@mcap/core";
import { FileHandleReadable, FileHandleWritable } from "@mcap/nodejs";
import * as lz4 from "lz4js";

import { decodeRos2CompressedImage } from "./shared/cdr";
import { loadMcapDecompressHandlers } from "./shared/decompress";
import { buildProvenance } from "./shared/provenance";
import type {
  ChannelSummary,
  Compression,
  RecordingSummary,
  SchemaSummary,
  WorkerFrameResult,
  WorkerRequest,
  WorkerResponse,
  WorkerVideoIndexResult
} from "./shared/protocol";

if (!parentPort) {
  throw new Error("The MCAP worker must run in a worker thread.");
}

interface VideoFrameInfo {
  logTime: bigint;
  publishTime: bigint;
  sequence: number;
}

interface LoadedSource {
  path: string;
  size: bigint;
  mtimeMs: number;
  handle: Awaited<ReturnType<typeof open>>;
  reader: McapIndexedReader;
  metadata: Metadata[];
  metadataError?: string;
  summary: RecordingSummary;
}

let currentGeneration = 0;
let source: LoadedSource | undefined;
const videoFrames = new Map<number, VideoFrameInfo[]>();
const canceledOperations = new Set<string>();

function post(message: WorkerResponse): void {
  parentPort!.postMessage(message);
}

function progress(
  request: WorkerRequest,
  operation: "load" | "videoIndex" | "export",
  message: string,
  value?: number
): void {
  post({
    type: "progress",
    requestId: request.requestId,
    generation: request.generation,
    operation,
    message,
    progress: value
  });
}

function ensureCurrent(request: WorkerRequest): LoadedSource {
  if (!source || request.generation !== currentGeneration) {
    throw Object.assign(new Error("The recording session is no longer current."), { code: "STALE_SESSION" });
  }
  return source;
}

function ensureNotCanceled(requestId: string): void {
  if (canceledOperations.has(requestId)) {
    throw Object.assign(new Error("Operation canceled."), { code: "CANCELED" });
  }
}

async function closeSource(): Promise<void> {
  const previous = source;
  source = undefined;
  videoFrames.clear();
  if (previous) {
    await previous.handle.close().catch(() => undefined);
  }
}

function preferredVideoOrder(channel: ChannelSummary): number {
  if (channel.topic === "/hal/camera/head/color/compressed") {
    return 100;
  }
  let score = 0;
  if (/color/i.test(channel.topic)) {
    score += 1;
  }
  if (/head/i.test(channel.topic)) {
    score += 2;
  }
  return score;
}

async function loadRecording(request: Extract<WorkerRequest, { type: "load" }>): Promise<{ recording: RecordingSummary }> {
  currentGeneration = request.generation;
  await closeSource();
  progress(request, "load", "Reading indexed MCAP summary…");

  const handle = await open(request.path, "r");
  try {
    const fileStat = await handle.stat();
    const decompressHandlers = await loadMcapDecompressHandlers();
    let reader: McapIndexedReader;
    try {
      reader = await McapIndexedReader.Initialize({
        readable: new FileHandleReadable(handle),
        decompressHandlers,
        messageIndexCacheSizeBytes: 16 * 1024 * 1024
      });
    } catch (error) {
      if (/not indexed/i.test(errorMessage(error))) {
        throw Object.assign(
          new Error("This MCAP is not indexed. Reindex it before opening it in MCAP Slice."),
          { code: "UNINDEXED_MCAP" }
        );
      }
      throw error;
    }
    const statistics = reader.statistics;
    if (!statistics || reader.footer.summaryStart === 0n) {
      throw Object.assign(
        new Error("This MCAP has no readable Summary. Reindex it before opening it in MCAP Slice."),
        { code: "UNINDEXED_MCAP" }
      );
    }
    if (statistics.messageCount > 0n && reader.chunkIndexes.length === 0) {
      throw Object.assign(
        new Error("This MCAP has no readable Chunk Index. Reindex it before opening it in MCAP Slice."),
        { code: "UNINDEXED_MCAP" }
      );
    }

    const schemas: SchemaSummary[] = [...reader.schemasById.values()]
      .sort((left, right) => left.id - right.id)
      .map((schema) => ({
        id: schema.id,
        name: schema.name,
        encoding: schema.encoding,
        text: new TextDecoder("utf-8").decode(schema.data)
      }));
    const schemaById = new Map(schemas.map((schema) => [schema.id, schema]));
    const channels: ChannelSummary[] = [...reader.channelsById.values()]
      .sort((left, right) => left.topic.localeCompare(right.topic) || left.id - right.id)
      .map((channel) => {
        const schema = schemaById.get(channel.schemaId);
        return {
          id: channel.id,
          topic: channel.topic,
          messageEncoding: channel.messageEncoding,
          schemaId: channel.schemaId,
          schemaName: schema?.name ?? "",
          schemaEncoding: schema?.encoding ?? "",
          messageCount: (statistics.channelMessageCounts.get(channel.id) ?? 0n).toString()
        };
      });

    const metadata: Metadata[] = [];
    let metadataError: string | undefined;
    try {
      for await (const item of reader.readMetadata()) {
        metadata.push({ name: item.name, metadata: new Map(item.metadata) });
      }
    } catch (error) {
      metadataError = `Unable to preserve source Metadata: ${errorMessage(error)}`;
    }

    const videoStreams = channels
      .filter(
        (channel) =>
          channel.schemaName === "sensor_msgs/msg/CompressedImage" &&
          channel.messageEncoding === "cdr" &&
          !/depth/i.test(channel.topic)
      )
      .sort((left, right) => preferredVideoOrder(right) - preferredVideoOrder(left) || left.topic.localeCompare(right.topic))
      .map((channel) => ({ channelId: channel.id, topic: channel.topic }));

    const summary: RecordingSummary = {
      sourceName: path.basename(request.path),
      sourceSizeBytes: BigInt(fileStat.size).toString(),
      sourceMtimeMs: fileStat.mtimeMs,
      profile: reader.header.profile,
      library: reader.header.library,
      messageCount: statistics.messageCount.toString(),
      channelCount: statistics.channelCount,
      startNs: statistics.messageStartTime.toString(),
      endNs: statistics.messageEndTime.toString(),
      channels,
      schemas,
      videoStreams,
      attachmentCount: statistics.attachmentCount,
      metadataCount: statistics.metadataCount,
      metadataError
    };

    source = {
      path: request.path,
      size: BigInt(fileStat.size),
      mtimeMs: fileStat.mtimeMs,
      handle,
      reader,
      metadata,
      metadataError,
      summary
    };
    progress(request, "load", "Recording loaded", 1);
    return { recording: summary };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function indexVideo(
  request: Extract<WorkerRequest, { type: "indexVideo" }>
): Promise<WorkerVideoIndexResult> {
  const loaded = ensureCurrent(request);
  const channel = loaded.reader.channelsById.get(request.channelId);
  if (!channel) {
    throw new Error("The selected video channel no longer exists.");
  }
  const schema = loaded.reader.schemasById.get(channel.schemaId);
  if (schema?.name !== "sensor_msgs/msg/CompressedImage" || channel.messageEncoding !== "cdr") {
    throw new Error("The selected channel is not a ROS 2 CDR CompressedImage stream.");
  }

  progress(request, "videoIndex", `Indexing ${channel.topic}…`, 0);
  const frames: VideoFrameInfo[] = [];
  const expected = loaded.reader.statistics?.channelMessageCounts.get(channel.id) ?? 0n;
  let visited = 0;
  for await (const message of loaded.reader.readMessages({ topics: [channel.topic], validateCrcs: true })) {
    ensureNotCanceled(request.requestId);
    ensureCurrent(request);
    if (message.channelId === channel.id) {
      frames.push({ logTime: message.logTime, publishTime: message.publishTime, sequence: message.sequence });
      visited += 1;
      if (visited % 250 === 0) {
        const ratio = expected > 0n ? Math.min(1, visited / Number(expected)) : undefined;
        progress(request, "videoIndex", `Indexed ${visited.toLocaleString()} frames…`, ratio);
      }
    }
  }
  frames.sort(
    (left, right) =>
      compareBigInt(left.logTime, right.logTime) ||
      left.sequence - right.sequence ||
      compareBigInt(left.publishTime, right.publishTime)
  );
  videoFrames.set(channel.id, frames);
  progress(request, "videoIndex", `Indexed ${frames.length.toLocaleString()} frames`, 1);
  return {
    channelId: channel.id,
    frameCount: frames.length,
    firstLogTimeNs: frames[0]?.logTime.toString(),
    lastLogTimeNs: frames.at(-1)?.logTime.toString()
  };
}

async function readFrame(
  request: Extract<WorkerRequest, { type: "readFrame" }>
): Promise<WorkerFrameResult> {
  const loaded = ensureCurrent(request);
  const frames = videoFrames.get(request.channelId);
  const frame = frames?.[request.frameIndex];
  if (!frames || !frame) {
    throw new Error("The requested video frame is outside the indexed range.");
  }
  const channel = loaded.reader.channelsById.get(request.channelId);
  if (!channel) {
    throw new Error("The selected video channel no longer exists.");
  }
  const endTime = frame.logTime < 0xffff_ffff_ffff_ffffn ? frame.logTime + 1n : frame.logTime;
  for await (const message of loaded.reader.readMessages({
    topics: [channel.topic],
    startTime: frame.logTime,
    endTime,
    validateCrcs: true
  })) {
    if (
      message.channelId !== request.channelId ||
      message.logTime !== frame.logTime ||
      message.publishTime !== frame.publishTime ||
      message.sequence !== frame.sequence
    ) {
      continue;
    }
    const decoded = decodeRos2CompressedImage(message.data);
    return {
      channelId: request.channelId,
      frameIndex: request.frameIndex,
      frameCount: frames.length,
      logTimeNs: message.logTime.toString(),
      publishTimeNs: message.publishTime.toString(),
      sequence: message.sequence,
      captureTimeNs: decoded.captureTimeNs.toString(),
      frameId: decoded.frameId,
      format: decoded.format,
      mimeType: decoded.mimeType,
      image: decoded.data
    };
  }
  throw new Error("The indexed video frame could not be found in the recording.");
}

function seekFrame(request: Extract<WorkerRequest, { type: "seekFrame" }>): number {
  ensureCurrent(request);
  const frames = videoFrames.get(request.channelId);
  if (!frames || frames.length === 0) {
    throw new Error("The selected video stream has not been indexed.");
  }
  const target = BigInt(request.timestampNs);
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle]!.logTime <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(0, low - 1);
}

function compressor(compression: Compression): ((data: Uint8Array) => { compression: string; compressedData: Uint8Array }) | undefined {
  if (compression === "none") {
    return undefined;
  }
  if (compression === "zstd") {
    return (data) => ({ compression: "zstd", compressedData: zstd.compress(data) });
  }
  return (data) => ({ compression: "lz4", compressedData: lz4.compress(data) });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function commitOutput(tempPath: string, destinationPath: string): Promise<void> {
  if (!(await pathExists(destinationPath))) {
    await rename(tempPath, destinationPath);
    return;
  }
  const backupPath = `${destinationPath}.mcap-slice-${randomUUID()}.bak`;
  await rename(destinationPath, backupPath);
  try {
    await rename(tempPath, destinationPath);
  } catch (error) {
    await rename(backupPath, destinationPath).catch(() => undefined);
    throw error;
  }
  // The destination has already been committed at this point. A backup cleanup
  // failure must not turn a successful atomic replacement into a reported
  // export failure.
  await rm(backupPath, { force: true }).catch(() => undefined);
}

async function ensureSourceUnchanged(loaded: LoadedSource): Promise<void> {
  const current = await stat(loaded.path);
  if (BigInt(current.size) !== loaded.size || current.mtimeMs !== loaded.mtimeMs) {
    throw Object.assign(
      new Error("The source MCAP changed on disk. Reload it before exporting."),
      { code: "SOURCE_CHANGED" }
    );
  }
}

async function exportSlice(request: Extract<WorkerRequest, { type: "export" }>): Promise<{ destinationPath: string }> {
  const loaded = ensureCurrent(request);
  await ensureSourceUnchanged(loaded);
  if (loaded.metadataError) {
    throw new Error(loaded.metadataError);
  }
  const startTime = BigInt(request.startNs);
  const endTime = BigInt(request.endNs);
  if (startTime >= endTime) {
    throw new Error("The export start time must be earlier than the end time.");
  }
  const availableTopics = new Set([...loaded.reader.channelsById.values()].map((channel) => channel.topic));
  const selectedTopics = [...new Set(request.selectedTopics)].filter((topic) => availableTopics.has(topic)).sort();
  if (selectedTopics.length === 0) {
    throw new Error("Select at least one topic before exporting.");
  }
  const sourcePath = path.resolve(loaded.path);
  const destinationPath = path.resolve(request.destinationPath);
  const samePath = process.platform === "win32"
    ? sourcePath.toLocaleLowerCase() === destinationPath.toLocaleLowerCase()
    : sourcePath === destinationPath;
  if (samePath) {
    throw new Error("MCAP Slice never overwrites the source recording. Choose a different destination.");
  }

  const tempPath = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.mcap-slice-${randomUUID()}.tmp`);
  let outputHandle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  canceledOperations.delete(request.requestId);
  try {
    progress(request, "export", "Preparing output…", 0);
    if (request.compression === "zstd") {
      await zstd.isLoaded;
    }
    outputHandle = await open(tempPath, "wx");
    const writer = new McapWriter({
      writable: new FileHandleWritable(outputHandle),
      useChunks: true,
      useStatistics: true,
      useSummaryOffsets: true,
      useMessageIndex: true,
      useChunkIndex: true,
      useMetadataIndex: true,
      repeatSchemas: true,
      repeatChannels: true,
      compressChunk: compressor(request.compression)
    });
    await writer.start({ profile: loaded.reader.header.profile, library: `MCAP Slice/${request.extensionVersion}` });

    const selectedChannels = [...loaded.reader.channelsById.values()].filter((channel) => selectedTopics.includes(channel.topic));
    const schemaMap = new Map<number, number>();
    const channelMap = new Map<number, number>();
    for (const channel of selectedChannels) {
      let newSchemaId = 0;
      if (channel.schemaId !== 0) {
        const existingSchemaId = schemaMap.get(channel.schemaId);
        if (existingSchemaId !== undefined) {
          newSchemaId = existingSchemaId;
        } else {
          const schema = loaded.reader.schemasById.get(channel.schemaId);
          if (!schema) {
            throw new Error(`Channel ${channel.id} references missing schema ${channel.schemaId}.`);
          }
          newSchemaId = await writer.registerSchema({ name: schema.name, encoding: schema.encoding, data: schema.data });
          schemaMap.set(channel.schemaId, newSchemaId);
        }
      }
      const newChannelId = await writer.registerChannel({
        schemaId: newSchemaId,
        topic: channel.topic,
        messageEncoding: channel.messageEncoding,
        metadata: new Map(channel.metadata)
      });
      channelMap.set(channel.id, newChannelId);
    }

    const totalMessages = loaded.reader.statistics?.messageCount ?? 0n;
    let processed = 0n;
    for await (const message of loaded.reader.readMessages({
      topics: selectedTopics,
      startTime,
      endTime,
      validateCrcs: true
    })) {
      ensureNotCanceled(request.requestId);
      ensureCurrent(request);
      const newChannelId = channelMap.get(message.channelId);
      if (newChannelId === undefined) {
        continue;
      }
      await writer.addMessage({
        channelId: newChannelId,
        sequence: message.sequence,
        logTime: message.logTime,
        publishTime: message.publishTime,
        data: message.data
      });
      processed += 1n;
      if (processed % 250n === 0n) {
        const ratio = totalMessages > 0n ? Math.min(0.95, Number(processed) / Number(totalMessages)) : undefined;
        progress(request, "export", `Exported ${processed.toLocaleString()} messages…`, ratio);
      }
    }

    for (const metadata of loaded.metadata) {
      await writer.addMetadata({ name: metadata.name, metadata: new Map(metadata.metadata) });
    }
    await writer.addMetadata(
      buildProvenance({
        extensionVersion: request.extensionVersion,
        sourcePath: loaded.path,
        sourceSizeBytes: loaded.size,
        sourceStartNs: BigInt(loaded.summary.startNs),
        sourceEndNs: BigInt(loaded.summary.endNs),
        sliceStartNs: startTime,
        sliceEndNs: endTime,
        selectedTopics
      })
    );
    await writer.end();
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = undefined;
    ensureNotCanceled(request.requestId);
    await ensureSourceUnchanged(loaded);
    progress(request, "export", "Committing output…", 0.98);
    await commitOutput(tempPath, destinationPath);
    committed = true;
    progress(request, "export", "Export complete", 1);
    return { destinationPath };
  } finally {
    canceledOperations.delete(request.requestId);
    if (outputHandle) {
      await outputHandle.close().catch(() => undefined);
    }
    if (!committed) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleRequest(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case "load":
      return await loadRecording(request);
    case "indexVideo":
      return await indexVideo(request);
    case "readFrame":
      return await readFrame(request);
    case "seekFrame":
      return { frameIndex: seekFrame(request) };
    case "export":
      return await exportSlice(request);
    case "cancel":
      canceledOperations.add(request.operationId);
      return {};
    case "dispose":
      await closeSource();
      return {};
  }
}

parentPort.on("message", (request: WorkerRequest) => {
  void handleRequest(request)
    .then((result) => {
      post({ type: "result", requestId: request.requestId, generation: request.generation, result });
    })
    .catch((error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      post({
        type: "error",
        requestId: request.requestId,
        generation: request.generation,
        message: errorMessage(error),
        code
      });
    });
});
