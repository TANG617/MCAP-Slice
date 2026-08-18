import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { McapIndexedReader } from "@mcap/core";
import { FileHandleReadable } from "@mcap/nodejs";
import { afterEach, describe, expect, it } from "vitest";

import { loadMcapDecompressHandlers } from "../src/shared/decompress";
import type { Compression, WorkerRequest, WorkerResponse } from "../src/shared/protocol";
import { BASE_TIME_NS, writeCorruptedFixture, writeIndexedFixture, writeUnindexedFixture } from "./fixtures";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: WorkerTestError) => void;
  progress?: (message: Extract<WorkerResponse, { type: "progress" }>) => void;
}

class WorkerTestError extends Error {
  public constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

class WorkerHarness {
  readonly #worker = new Worker(path.resolve("dist/mcap-worker.js"));
  readonly #pending = new Map<string, Pending>();

  public constructor() {
    this.#worker.on("message", (message: WorkerResponse) => {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      if (message.type === "progress") {
        pending.progress?.(message);
      } else if (message.type === "error") {
        this.#pending.delete(message.requestId);
        pending.reject(new WorkerTestError(message.message, message.code));
      } else {
        this.#pending.delete(message.requestId);
        pending.resolve(message.result);
      }
    });
  }

  public call<T>(request: WorkerRequest, progress?: Pending["progress"]): Promise<T> {
    return new Promise((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve: (value) => resolve(value as T), reject, progress });
      this.#worker.postMessage(request);
    });
  }

  public cancel(generation: number, operationId: string): void {
    this.#worker.postMessage({ type: "cancel", requestId: randomUUID(), generation, operationId } satisfies WorkerRequest);
  }

  public async dispose(): Promise<void> {
    await this.#worker.terminate();
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcap-slice-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function readRecording(filePath: string): Promise<{
  reader: McapIndexedReader;
  close: () => Promise<void>;
  messageCount: number;
  metadata: { name: string; metadata: Map<string, string> }[];
}> {
  const handle = await open(filePath, "r");
  const reader = await McapIndexedReader.Initialize({
    readable: new FileHandleReadable(handle),
    decompressHandlers: await loadMcapDecompressHandlers()
  });
  let messageCount = 0;
  for await (const message of reader.readMessages()) messageCount += message.type === "Message" ? 1 : 0;
  const metadata = [];
  for await (const item of reader.readMetadata()) metadata.push({ name: item.name, metadata: item.metadata });
  return { reader, close: async () => await handle.close(), messageCount, metadata };
}

describe("MCAP worker", () => {
  it("loads indexed metadata and retrieves an image frame on demand", async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, "source.mcap");
    await writeIndexedFixture(source);
    const harness = new WorkerHarness();
    try {
      const loaded = await harness.call<{ recording: { attachmentCount: number; metadataCount: number; channels: unknown[]; videoStreams: { channelId: number }[]; jointStateStreams: { channelId: number; topic: string }[] } }>({
        type: "load", requestId: "load", generation: 1, path: source
      });
      expect(loaded.recording.attachmentCount).toBe(1);
      expect(loaded.recording.metadataCount).toBe(1);
      expect(loaded.recording.channels).toHaveLength(6);
      expect(loaded.recording.videoStreams).toHaveLength(1);
      expect(loaded.recording.jointStateStreams).toHaveLength(2);
      expect(loaded.recording.jointStateStreams[0]?.topic).toBe("/joint_states");
      const channelId = loaded.recording.videoStreams[0]!.channelId;
      const jointChannelId = loaded.recording.jointStateStreams[0]!.channelId;
      const [index, jointIndex] = await Promise.all([
        harness.call<{ frameCount: number }>({ type: "indexVideo", requestId: "index", generation: 1, channelId }),
        harness.call<{ messageCount: number; firstLogTimeNs: string }>({
          type: "indexJointStates", requestId: "joint-index", generation: 1, channelId: jointChannelId
        })
      ]);
      expect(index.frameCount).toBe(2);
      expect(jointIndex.messageCount).toBe(2);
      const frame = await harness.call<{ mimeType: string; frameId: string; image: Uint8Array }>({
        type: "readFrame", requestId: "frame", generation: 1, channelId, frameIndex: 0
      });
      expect(frame.mimeType).toBe("image/png");
      expect(frame.frameId).toBe("camera");
      expect(frame.image.slice(0, 4)).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
      const sought = await harness.call<{ frameIndex: number }>({
        type: "seekFrame",
        requestId: "seek",
        generation: 1,
        channelId,
        timestampNs: (BASE_TIME_NS + 3_500_000n).toString()
      });
      expect(sought.frameIndex).toBe(1);
      const jpeg = await harness.call<{ mimeType: string }>({
        type: "readFrame",
        requestId: "jpeg",
        generation: 1,
        channelId,
        frameIndex: sought.frameIndex
      });
      expect(jpeg.mimeType).toBe("image/jpeg");

      const before = await harness.call<{ state: string }>({
        type: "readJointStateAt",
        requestId: "joint-before",
        generation: 1,
        channelId: jointChannelId,
        timestampNs: (BigInt(jointIndex.firstLogTimeNs) - 1n).toString()
      });
      expect(before.state).toBe("noState");
      const joints = await harness.call<{ state: string; names: string[]; positions: number[] }>({
        type: "readJointStateAt",
        requestId: "joint-read",
        generation: 1,
        channelId: jointChannelId,
        timestampNs: (BASE_TIME_NS + 10_000_000n).toString()
      });
      expect(joints).toMatchObject({ state: "ready", names: ["shoulder", "slide"], positions: [0.5, 0.1] });

      const alternateChannelId = loaded.recording.jointStateStreams[1]!.channelId;
      await harness.call({ type: "indexJointStates", requestId: "alternate-index", generation: 1, channelId: alternateChannelId });
      const alternate = await harness.call<{ state: string; names: string[]; positions: number[] }>({
        type: "readJointStateAt",
        requestId: "alternate-read",
        generation: 1,
        channelId: alternateChannelId,
        timestampNs: (BASE_TIME_NS + 10_000_000n).toString()
      });
      expect(alternate).toMatchObject({ state: "ready", names: ["shoulder"], positions: [-0.25] });
    } finally {
      await harness.dispose();
    }
  });

  it.skipIf(!process.env.MCAP_SLICE_REAL_MCAP || !process.env.MCAP_SLICE_REAL_URDF)(
    "synchronizes a real video frame with the matching robot JointState by log_time",
    async () => {
      const harness = new WorkerHarness();
      try {
        const loaded = await harness.call<{
          recording: {
            videoStreams: { channelId: number; topic: string }[];
            jointStateStreams: { channelId: number; topic: string }[];
          };
        }>({
          type: "load",
          requestId: "real-load",
          generation: 1,
          path: process.env.MCAP_SLICE_REAL_MCAP!
        });
        const video = loaded.recording.videoStreams.find(
          (stream) => stream.topic === "/hal/camera/head/color/compressed"
        ) ?? loaded.recording.videoStreams[0];
        const jointTopic = process.env.MCAP_SLICE_REAL_JOINT_TOPIC ?? "/hal/joint_states";
        const joints = loaded.recording.jointStateStreams.find(
          (stream) => stream.topic === jointTopic
        );
        expect(video).toBeDefined();
        expect(joints).toBeDefined();

        const [videoIndex] = await Promise.all([
          harness.call<{ frameCount: number }>({
            type: "indexVideo",
            requestId: "real-video-index",
            generation: 1,
            channelId: video!.channelId
          }),
          harness.call({
            type: "indexJointStates",
            requestId: "real-joint-index",
            generation: 1,
            channelId: joints!.channelId
          })
        ]);
        const frame = await harness.call<{ logTimeNs: string }>({
          type: "readFrame",
          requestId: "real-frame",
          generation: 1,
          channelId: video!.channelId,
          frameIndex: Math.floor(videoIndex.frameCount / 2)
        });
        const configuration = await harness.call<{
          state: string;
          logTimeNs: string;
          names: string[];
          positions: number[];
        }>({
          type: "readJointStateAt",
          requestId: "real-joint-read",
          generation: 1,
          channelId: joints!.channelId,
          timestampNs: frame.logTimeNs
        });
        expect(configuration.state).toBe("ready");
        expect(BigInt(configuration.logTimeNs)).toBeLessThanOrEqual(BigInt(frame.logTimeNs));
        expect(configuration.names).toHaveLength(configuration.positions.length);

        const urdf = await readFile(process.env.MCAP_SLICE_REAL_URDF!, "utf8");
        const urdfJoints = new Set([...urdf.matchAll(/<joint\s+name="([^"]+)"/g)].map((match) => match[1]!));
        const matched = configuration.names.filter((name) => urdfJoints.has(name));
        expect(matched.length).toBeGreaterThan(10);

        const laterFrame = await harness.call<{ logTimeNs: string }>({
          type: "readFrame",
          requestId: "real-later-frame",
          generation: 1,
          channelId: video!.channelId,
          frameIndex: Math.floor(videoIndex.frameCount * 0.8)
        });
        const laterConfiguration = await harness.call<{
          state: string;
          positions: number[];
        }>({
          type: "readJointStateAt",
          requestId: "real-later-joint-read",
          generation: 1,
          channelId: joints!.channelId,
          timestampNs: laterFrame.logTimeNs
        });
        expect(laterConfiguration.state).toBe("ready");
        expect(
          laterConfiguration.positions.some(
            (position, index) => Math.abs(position - configuration.positions[index]!) > 1e-6
          )
        ).toBe(true);
      } finally {
        await harness.dispose();
      }
    },
    10 * 60_000
  );

  it.each(["none", "zstd", "lz4"] as Compression[])("exports a valid %s slice without modifying the source", async (compression) => {
    const directory = await tempDirectory();
    const source = path.join(directory, "source.mcap");
    const destination = path.join(directory, `${compression}.mcap`);
    await writeIndexedFixture(source);
    const before = createHash("sha256").update(await readFile(source)).digest("hex");
    const harness = new WorkerHarness();
    try {
      await harness.call({ type: "load", requestId: "load", generation: 1, path: source });
      await harness.call({
        type: "export",
        requestId: "export",
        generation: 1,
        destinationPath: destination,
        extensionVersion: "0.1.0",
        startNs: BASE_TIME_NS.toString(),
        endNs: (BASE_TIME_NS + 1_500_000n).toString(),
        selectedTopics: ["/duplicate"],
        compression
      });
      expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(before);
      const output = await readRecording(destination);
      try {
        expect(output.messageCount).toBe(2);
        expect([...output.reader.channelsById.values()].map((channel) => channel.topic)).toEqual(["/duplicate", "/duplicate"]);
        expect(output.reader.attachmentIndexes).toHaveLength(0);
        expect(output.metadata.map((item) => item.name)).toEqual(["source.metadata", "mcap_slice.provenance.v1"]);
        expect(output.metadata.at(-1)?.metadata.get("slice.selected_topics_json")).toBe('["/duplicate"]');
        expect(new Set(output.reader.chunkIndexes.map((chunk) => chunk.compression))).toEqual(
          new Set([compression === "none" ? "" : compression])
        );
      } finally {
        await output.close();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("rejects unindexed files with an actionable error", async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, "unindexed.mcap");
    await writeUnindexedFixture(source);
    const harness = new WorkerHarness();
    try {
      await expect(harness.call({ type: "load", requestId: "load", generation: 1, path: source })).rejects.toMatchObject({
        code: "UNINDEXED_MCAP"
      });
    } finally {
      await harness.dispose();
    }
  });

  it("rejects a corrupted file without classifying it as merely unindexed", async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, "corrupted.mcap");
    await writeCorruptedFixture(source);
    const harness = new WorkerHarness();
    try {
      await expect(
        harness.call({ type: "load", requestId: "load", generation: 1, path: source })
      ).rejects.not.toMatchObject({ code: "UNINDEXED_MCAP" });
    } finally {
      await harness.dispose();
    }
  });

  it("cancels an export and removes its temporary output", async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, "large.mcap");
    const destination = path.join(directory, "canceled.mcap");
    await writeIndexedFixture(source, 2_000);
    const harness = new WorkerHarness();
    try {
      await harness.call({ type: "load", requestId: "load", generation: 1, path: source });
      let canceled = false;
      const exportPromise = harness.call(
        {
          type: "export",
          requestId: "cancel-me",
          generation: 1,
          destinationPath: destination,
          extensionVersion: "0.1.0",
          startNs: BASE_TIME_NS.toString(),
          endNs: (BASE_TIME_NS + 60_000_000_000n).toString(),
          selectedTopics: ["/duplicate", "/other"],
          compression: "zstd"
        },
        (message) => {
          if (!canceled && message.operation === "export") {
            canceled = true;
            harness.cancel(1, "cancel-me");
          }
        }
      );
      await expect(exportPromise).rejects.toMatchObject({ code: "CANCELED" });
      await expect(stat(destination)).rejects.toBeDefined();
      expect((await readdir(directory)).filter((name) => name.includes("mcap-slice") || name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});
