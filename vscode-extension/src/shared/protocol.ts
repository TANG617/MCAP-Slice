export type Compression = "zstd" | "lz4" | "none";

export interface ChannelSummary {
  id: number;
  topic: string;
  messageEncoding: string;
  schemaId: number;
  schemaName: string;
  schemaEncoding: string;
  messageCount: string;
}

export interface SchemaSummary {
  id: number;
  name: string;
  encoding: string;
  text: string;
}

export interface VideoStreamSummary {
  channelId: number;
  topic: string;
}

export interface RecordingSummary {
  sourceName: string;
  sourceSizeBytes: string;
  sourceMtimeMs: number;
  profile: string;
  library: string;
  messageCount: string;
  channelCount: number;
  startNs: string;
  endNs: string;
  channels: ChannelSummary[];
  schemas: SchemaSummary[];
  videoStreams: VideoStreamSummary[];
  attachmentCount: number;
  metadataCount: number;
  metadataError?: string;
}

interface WebviewMessageBase {
  type: string;
  requestId: string;
  generation: number;
}

export type WebviewToHostMessage =
  | (WebviewMessageBase & { type: "ready" })
  | (WebviewMessageBase & { type: "selectVideoStream"; channelId: number })
  | (WebviewMessageBase & { type: "requestFrame"; frameIndex: number })
  | (WebviewMessageBase & { type: "seekFrame"; timestampNs: string })
  | (WebviewMessageBase & {
      type: "exportSlice";
      startNs: string;
      endNs: string;
      selectedTopics: string[];
      compression: Compression;
    })
  | (WebviewMessageBase & { type: "reloadSource" })
  | (WebviewMessageBase & { type: "cancelOperation"; operationId: string });

interface HostMessageBase {
  type: string;
  requestId: string;
  generation: number;
}

export type HostToWebviewMessage =
  | (HostMessageBase & { type: "loadingState"; message: string })
  | (HostMessageBase & { type: "recordingLoaded"; recording: RecordingSummary })
  | (HostMessageBase & {
      type: "videoIndexState";
      channelId: number;
      state: "indexing" | "ready" | "empty";
      frameCount?: number;
      firstLogTimeNs?: string;
      lastLogTimeNs?: string;
      progress?: number;
    })
  | (HostMessageBase & {
      type: "frameResult";
      channelId: number;
      frameIndex: number;
      frameCount: number;
      logTimeNs: string;
      publishTimeNs: string;
      sequence: number;
      captureTimeNs: string;
      frameId: string;
      format: string;
      mimeType: "image/jpeg" | "image/png";
      image: ArrayBuffer;
    })
  | (HostMessageBase & {
      type: "exportState";
      state: "choosingDestination" | "exporting" | "success" | "canceled";
      operationId?: string;
      progress?: number;
      message?: string;
    })
  | (HostMessageBase & { type: "sourceChanged"; message: string })
  | (HostMessageBase & { type: "operationError"; operation: string; message: string })
  | (HostMessageBase & { type: "requestExport" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === "string" &&
    typeof value.requestId === "string" &&
    Number.isInteger(value.generation) &&
    Number(value.generation) >= 0
  );
}

function isDecimalNanoseconds(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(value) || !hasBase(value)) {
    return undefined;
  }
  switch (value.type) {
    case "ready":
    case "reloadSource":
      return value as unknown as WebviewToHostMessage;
    case "selectVideoStream":
      return Number.isInteger(value.channelId) && Number(value.channelId) >= 0
        ? (value as unknown as WebviewToHostMessage)
        : undefined;
    case "requestFrame":
      return Number.isInteger(value.frameIndex) && Number(value.frameIndex) >= 0
        ? (value as unknown as WebviewToHostMessage)
        : undefined;
    case "seekFrame":
      return isDecimalNanoseconds(value.timestampNs) ? (value as unknown as WebviewToHostMessage) : undefined;
    case "cancelOperation":
      return typeof value.operationId === "string" ? (value as unknown as WebviewToHostMessage) : undefined;
    case "exportSlice": {
      const compressionOk = value.compression === "zstd" || value.compression === "lz4" || value.compression === "none";
      const topicsOk =
        Array.isArray(value.selectedTopics) && value.selectedTopics.every((topic) => typeof topic === "string");
      return compressionOk && topicsOk && isDecimalNanoseconds(value.startNs) && isDecimalNanoseconds(value.endNs)
        ? (value as unknown as WebviewToHostMessage)
        : undefined;
    }
    default:
      return undefined;
  }
}

export interface WorkerLoadResult {
  recording: RecordingSummary;
}

export interface WorkerVideoIndexResult {
  channelId: number;
  frameCount: number;
  firstLogTimeNs?: string;
  lastLogTimeNs?: string;
}

export interface WorkerFrameResult {
  channelId: number;
  frameIndex: number;
  frameCount: number;
  logTimeNs: string;
  publishTimeNs: string;
  sequence: number;
  captureTimeNs: string;
  frameId: string;
  format: string;
  mimeType: "image/jpeg" | "image/png";
  image: Uint8Array;
}

export type WorkerRequest =
  | { type: "load"; requestId: string; generation: number; path: string }
  | { type: "indexVideo"; requestId: string; generation: number; channelId: number }
  | { type: "readFrame"; requestId: string; generation: number; channelId: number; frameIndex: number }
  | { type: "seekFrame"; requestId: string; generation: number; channelId: number; timestampNs: string }
  | {
      type: "export";
      requestId: string;
      generation: number;
      destinationPath: string;
      extensionVersion: string;
      startNs: string;
      endNs: string;
      selectedTopics: string[];
      compression: Compression;
    }
  | { type: "cancel"; requestId: string; generation: number; operationId: string }
  | { type: "dispose"; requestId: string; generation: number };

export type WorkerResponse =
  | { type: "result"; requestId: string; generation: number; result: unknown }
  | { type: "error"; requestId: string; generation: number; message: string; code?: string }
  | {
      type: "progress";
      requestId: string;
      generation: number;
      operation: "load" | "videoIndex" | "export";
      progress?: number;
      message: string;
    };
