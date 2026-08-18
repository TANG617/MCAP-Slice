import lz4Decompress from "@foxglove/wasm-lz4";
import * as zstd from "@foxglove/wasm-zstd";
import type { DecompressHandlers } from "@mcap/core";

let handlersPromise: Promise<DecompressHandlers> | undefined;

export async function loadMcapDecompressHandlers(): Promise<DecompressHandlers> {
  handlersPromise ??= Promise.all([lz4Decompress.isLoaded, zstd.isLoaded]).then(() => ({
    lz4: (buffer, decompressedSize) =>
      new Uint8Array(lz4Decompress(buffer, Number(decompressedSize))),
    zstd: (buffer, decompressedSize) =>
      new Uint8Array(zstd.decompress(buffer, Number(decompressedSize)))
  }));
  return await handlersPromise;
}
