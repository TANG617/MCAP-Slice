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
    expect(parseWebviewMessage({
      type: "selectJointStateStream",
      requestId: "joint-channel",
      generation: 1,
      channelId: 3
    })?.type).toBe("selectJointStateStream");
    expect(parseWebviewMessage({
      type: "seekJointState",
      requestId: "joint-seek",
      generation: 1,
      timestampNs: "1700000000000000000"
    })?.type).toBe("seekJointState");
    expect(parseWebviewMessage({
      type: "selectUrdf",
      requestId: "urdf",
      generation: 1
    })?.type).toBe("selectUrdf");
    expect(parseWebviewMessage({
      type: "rememberTopicSelection",
      requestId: "topics",
      generation: 1,
      selectedTopics: ["/camera", "/joint_states"]
    })?.type).toBe("rememberTopicSelection");
  });

  it("rejects bigint values, unknown compression, and invalid frame indexes", () => {
    expect(parseWebviewMessage({ type: "seekFrame", requestId: "one", generation: 1, timestampNs: 1n })).toBeUndefined();
    expect(parseWebviewMessage({ type: "requestFrame", requestId: "one", generation: 1, frameIndex: -1 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "exportSlice", requestId: "one", generation: 1, startNs: "1", endNs: "2", selectedTopics: [], compression: "gzip" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "rememberTopicSelection", requestId: "one", generation: 1, selectedTopics: [1] })).toBeUndefined();
    expect(parseWebviewMessage({ type: "selectVideoStream", requestId: "one", generation: 1, channelId: 2, remember: "yes" })).toBeUndefined();
  });
});
