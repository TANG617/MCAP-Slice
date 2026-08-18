import { access, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McapWriter } from "@mcap/core";
import { FileHandleWritable } from "@mcap/nodejs";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

async function writeFixture(filePath) {
  const handle = await open(filePath, "wx");
  try {
    const writer = new McapWriter({
      writable: new FileHandleWritable(handle),
      useChunks: true,
      useStatistics: true,
      useSummaryOffsets: true,
      useMessageIndex: true,
      useChunkIndex: true,
      repeatSchemas: true,
      repeatChannels: true
    });
    await writer.start({ profile: "integration-test", library: "mcap-slice-tests" });
    const schemaId = await writer.registerSchema({
      name: "example.Message",
      encoding: "jsonschema",
      data: new TextEncoder().encode('{"type":"object"}')
    });
    const channelId = await writer.registerChannel({
      schemaId,
      topic: "/integration",
      messageEncoding: "json",
      metadata: new Map()
    });
    await writer.addMessage({
      channelId,
      sequence: 0,
      logTime: 1_700_000_000_000_000_000n,
      publishTime: 1_700_000_000_000_000_000n,
      data: new TextEncoder().encode("{}")
    });
    await writer.end();
  } finally {
    await handle.close();
  }
}

const extensionRoot = path.resolve(import.meta.dirname, "../..");
const workspace = await mkdtemp(path.join(os.tmpdir(), "mcap-slice-vscode-test-"));
const fixture = path.join(workspace, "integration.mcap");

try {
  await writeFixture(fixture);
  let vscodeExecutablePath = await downloadAndUnzipVSCode();
  try {
    await access(vscodeExecutablePath);
  } catch (error) {
    const currentMacOsExecutable = path.join(path.dirname(vscodeExecutablePath), "Code");
    if (process.platform !== "darwin") {
      throw error;
    }
    await access(currentMacOsExecutable);
    vscodeExecutablePath = currentMacOsExecutable;
  }
  // Codex and some editor terminals run under an Extension Host process. Do
  // not leak that process mode into the nested Electron application.
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) {
      delete process.env[key];
    }
  }
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, "tests", "integration", "suite", "index.cjs"),
    extensionTestsEnv: { MCAP_SLICE_INTEGRATION_FILE: fixture },
    launchArgs: [workspace, "--disable-extensions", "--skip-welcome", "--skip-release-notes"]
  });
} finally {
  await rm(workspace, { recursive: true, force: true });
}
