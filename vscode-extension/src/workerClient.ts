import { randomUUID } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { WorkerRequest, WorkerResponse } from "./shared/protocol";

export class WorkerOperationError extends Error {
  public readonly code?: string;

  public constructor(message: string, code?: string) {
    super(message);
    this.name = "WorkerOperationError";
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (message: Extract<WorkerResponse, { type: "progress" }>) => void;
}

export class McapWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<string, PendingRequest>();
  #disposed = false;

  public constructor(extensionPath: string) {
    this.#worker = new Worker(path.join(extensionPath, "dist", "mcap-worker.js"));
    this.#worker.on("message", (message: WorkerResponse) => this.#handleMessage(message));
    this.#worker.on("error", (error) => this.#failAll(error));
    this.#worker.on("exit", (code) => {
      if (!this.#disposed && code !== 0) {
        this.#failAll(new Error(`MCAP worker exited unexpectedly with code ${code}.`));
      }
    });
  }

  public nextRequestId(): string {
    return randomUUID();
  }

  public call<T>(
    request: WorkerRequest,
    onProgress?: (message: Extract<WorkerResponse, { type: "progress" }>) => void
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new Error("MCAP worker has been disposed."));
    }
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(request.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress
      });
      this.#worker.postMessage(request);
    });
  }

  public cancel(generation: number, operationId: string): void {
    if (this.#disposed) {
      return;
    }
    this.#worker.postMessage({
      type: "cancel",
      requestId: this.nextRequestId(),
      generation,
      operationId
    } satisfies WorkerRequest);
  }

  public dispose(generation: number): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#worker.postMessage({
      type: "dispose",
      requestId: this.nextRequestId(),
      generation
    } satisfies WorkerRequest);
    this.#failAll(new Error("MCAP document was closed."));
    void this.#worker.terminate();
  }

  #handleMessage(message: WorkerResponse): void {
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      return;
    }
    if (message.type === "progress") {
      pending.onProgress?.(message);
      return;
    }
    this.#pending.delete(message.requestId);
    if (message.type === "error") {
      pending.reject(new WorkerOperationError(message.message, message.code));
    } else {
      pending.resolve(message.result);
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
