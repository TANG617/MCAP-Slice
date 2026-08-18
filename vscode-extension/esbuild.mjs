import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  external: [
    "vscode",
    "@foxglove/wasm-lz4",
    "@foxglove/wasm-zstd"
  ],
  logLevel: "info"
};

const configs = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" },
  { ...common, entryPoints: ["src/worker.ts"], outfile: "dist/mcap-worker.js" }
];

await mkdir("media", { recursive: true });
await mkdir("dist", { recursive: true });
await copyFile(path.resolve("..", "src", "mcap_slice.png"), path.resolve("media", "mcap_slice.png"));
await copyFile(path.resolve("..", "THIRD_PARTY_NOTICES.md"), path.resolve("dist", "THIRD_PARTY_NOTICES.md"));

if (watch) {
  const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
}
