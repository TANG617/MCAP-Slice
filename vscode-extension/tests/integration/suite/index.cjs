const assert = require("node:assert/strict");
const { utimes } = require("node:fs/promises");

const vscode = require("vscode");

async function waitFor(description, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`);
}

async function run() {
  const fixturePath = process.env.MCAP_SLICE_INTEGRATION_FILE;
  assert.ok(fixturePath, "The integration fixture path was not provided.");

  const extension = vscode.extensions.getExtension("TANG617.mcap-slice");
  assert.ok(extension, "The MCAP Slice extension was not discovered.");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("mcapSlice.exportSlice"));
  assert.ok(commands.includes("mcapSlice.reloadSource"));
  assert.ok(commands.includes("mcapSlice._testState"));

  const uri = vscode.Uri.file(fixturePath);
  await vscode.commands.executeCommand("vscode.open", uri, { preview: false });

  await waitFor("the default MCAP custom editor", async () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === "mcapSlice.editor";
  });

  const loaded = await waitFor("the Webview ready handshake", async () => {
    const state = await vscode.commands.executeCommand("mcapSlice._testState");
    return state?.active && state.loaded && !state.stale ? state : undefined;
  });
  assert.ok(loaded.generation > 0);

  const touched = new Date(Date.now() + 2_000);
  await utimes(fixturePath, touched, touched);
  await waitFor("the external source change", async () => {
    const state = await vscode.commands.executeCommand("mcapSlice._testState");
    return state?.stale;
  });

  await vscode.commands.executeCommand("mcapSlice.reloadSource");
  await waitFor("Reload Source", async () => {
    const state = await vscode.commands.executeCommand("mcapSlice._testState");
    return state?.loaded && !state.stale && state.generation > loaded.generation;
  });

  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
}

module.exports = { run };
