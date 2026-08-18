import { describe, expect, it } from "vitest";

import { parseWebviewMessage } from "../src/shared/protocol";

describe("Webview message validation", () => {
  it("accepts a valid export request", () => {
    expect(parseWebviewMessage({
      type: "exportSlice",
      requestId: "one",
      generation: 2,
      startNs: "1000000",
      endNs: "2000000",
      selectedTopics: ["/camera"],
      compression: "zstd"
    })?.type).toBe("exportSlice");
  });

  it("rejects bigint values, unknown compression, and invalid frame indexes", () => {
    expect(parseWebviewMessage({ type: "seekFrame", requestId: "one", generation: 1, timestampNs: 1n })).toBeUndefined();
    expect(parseWebviewMessage({ type: "requestFrame", requestId: "one", generation: 1, frameIndex: -1 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "exportSlice", requestId: "one", generation: 1, startNs: "1", endNs: "2", selectedTopics: [], compression: "gzip" })).toBeUndefined();
  });
});
