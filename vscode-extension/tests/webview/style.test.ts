import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("MCAP editor layout styles", () => {
  it("keeps both previews side by side and gives export the dominant lower area", async () => {
    const css = await readFile(new URL("../../src/webview/style.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.app-shell\s*\{[^}]*min-width:\s*56rem/);
    expect(css).toMatch(/\.preview-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
    expect(css).not.toMatch(/@media[\s\S]*?\.preview-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.export-workspace\s*\{[^}]*grid-template-columns:\s*var\(--export-settings-width, 19rem\)\s+12px\s+minmax\(36rem, 1fr\)/);
    expect(css).toMatch(/\.export-splitter\s*\{[^}]*cursor:\s*col-resize/);
    expect(css).toMatch(/\.export-splitter:hover::before[^}]*background:\s*var\(--accent\)/);
    expect(css).toContain("--accent: var(--vscode-button-background)");
    expect(css).toMatch(/\.export-primary-card\s*\{[^}]*border-top:\s*2px solid var\(--accent\)/);
  });
});
