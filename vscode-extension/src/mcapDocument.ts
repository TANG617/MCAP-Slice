import { watchFile, unwatchFile, type Stats } from "node:fs";

import * as vscode from "vscode";

import type {
  Compression,
  RecordingSummary,
  WorkerFrameResult,
  WorkerJointStateIndexResult,
  WorkerJointStateReadResult,
  WorkerLoadResult,
  WorkerVideoIndexResult
} from "./shared/protocol";
import { McapWorkerClient } from "./workerClient";

export interface DocumentProgress {
  operation: "load" | "videoIndex" | "jointStateIndex" | "export";
  message: string;
  progress?: number;
  requestId: string;
}

export interface ExportRequest {
  destinationPath: string;
  extensionVersion: string;
  startNs: string;
  endNs: string;
  selectedTopics: string[];
  compression: Compression;
}

export class McapDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  public generation = 0;
  public recording: RecordingSummary | undefined;
  public stale = false;

  readonly #worker: McapWorkerClient;
  readonly #onDidBecomeStale = new vscode.EventEmitter<string>();
  readonly #watchListener: (current: Stats, previous: Stats) => void;

  public readonly onDidBecomeStale = this.#onDidBecomeStale.event;

  public constructor(uri: vscode.Uri, extensionPath: string) {
    this.uri = uri;
    this.#worker = new McapWorkerClient(extensionPath);
    this.#watchListener = (current, previous) => {
      if (!this.recording || this.stale || current.size === 0 && previous.size === 0) {
        return;
      }
      if (current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) {
        const expectedSize = Number(this.recording.sourceSizeBytes);
        if (current.size !== expectedSize || current.mtimeMs !== this.recording.sourceMtimeMs) {
          this.stale = true;
          this.#onDidBecomeStale.fire("The MCAP changed on disk. Reload it before previewing or exporting.");
        }
      }
    };
    watchFile(this.uri.fsPath, { interval: 1_000, persistent: false }, this.#watchListener);
  }

  public async load(onProgress?: (progress: DocumentProgress) => void): Promise<RecordingSummary> {
    this.generation += 1;
    const requestId = this.#worker.nextRequestId();
    const result = await this.#worker.call<WorkerLoadResult>(
      { type: "load", requestId, generation: this.generation, path: this.uri.fsPath },
      (message) => onProgress?.({ ...message, requestId })
    );
    this.recording = result.recording;
    this.stale = false;
    return result.recording;
  }

  public async indexVideo(
    channelId: number,
    onProgress?: (progress: DocumentProgress) => void
  ): Promise<WorkerVideoIndexResult> {
    this.#ensureUsable();
    const requestId = this.#worker.nextRequestId();
    return await this.#worker.call<WorkerVideoIndexResult>(
      { type: "indexVideo", requestId, generation: this.generation, channelId },
      (message) => onProgress?.({ ...message, requestId })
    );
  }

  public async readFrame(channelId: number, frameIndex: number): Promise<WorkerFrameResult> {
    this.#ensureUsable();
    const requestId = this.#worker.nextRequestId();
    return await this.#worker.call<WorkerFrameResult>({
      type: "readFrame",
      requestId,
      generation: this.generation,
      channelId,
      frameIndex
    });
  }

  public async seekFrame(channelId: number, timestampNs: string): Promise<number> {
    this.#ensureUsable();
    const requestId = this.#worker.nextRequestId();
    const result = await this.#worker.call<{ frameIndex: number }>({
      type: "seekFrame",
      requestId,
      generation: this.generation,
      channelId,
      timestampNs
    });
    return result.frameIndex;
  }

  public async indexJointStates(
    channelId: number,
    onProgress?: (progress: DocumentProgress) => void
  ): Promise<WorkerJointStateIndexResult> {
    this.#ensureUsable();
    const requestId = this.#worker.nextRequestId();
    return await this.#worker.call<WorkerJointStateIndexResult>(
      { type: "indexJointStates", requestId, generation: this.generation, channelId },
      (message) => onProgress?.({ ...message, requestId })
    );
  }

  public async readJointStateAt(channelId: number, timestampNs: string): Promise<WorkerJointStateReadResult> {
    this.#ensureUsable();
    const requestId = this.#worker.nextRequestId();
    return await this.#worker.call<WorkerJointStateReadResult>({
      type: "readJointStateAt",
      requestId,
      generation: this.generation,
      channelId,
      timestampNs
    });
  }

  public startExport(
    request: ExportRequest,
    onProgress?: (progress: DocumentProgress) => void
  ): { operationId: string; promise: Promise<{ destinationPath: string }> } {
    this.#ensureUsable();
    const operationId = this.#worker.nextRequestId();
    const promise = this.#worker.call<{ destinationPath: string }>(
      {
        type: "export",
        requestId: operationId,
        generation: this.generation,
        ...request
      },
      (message) => onProgress?.({ ...message, requestId: operationId })
    );
    return { operationId, promise };
  }

  public cancel(operationId: string): void {
    this.#worker.cancel(this.generation, operationId);
  }

  public dispose(): void {
    unwatchFile(this.uri.fsPath, this.#watchListener);
    this.#onDidBecomeStale.dispose();
    this.#worker.dispose(this.generation);
  }

  #ensureUsable(): void {
    if (!this.recording) {
      throw new Error("The recording has not finished loading.");
    }
    if (this.stale) {
      throw new Error("The source MCAP changed on disk. Reload it before continuing.");
    }
  }
}
