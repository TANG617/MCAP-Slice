// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostToWebviewMessage, RecordingSummary } from "../../src/shared/protocol";

const postedMessages: unknown[] = [];

vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: (message: unknown) => postedMessages.push(message),
  getState: () => undefined,
  setState: () => undefined
}));

const { App } = await import("../../src/webview/App");

const recording: RecordingSummary = {
  sourceName: "demo.mcap",
  sourceSizeBytes: "1024",
  sourceMtimeMs: 1,
  profile: "ros2",
  library: "tests",
  messageCount: "4",
  channelCount: 2,
  startNs: "1700000000000000000",
  endNs: "1700000000003000000",
  channels: [
    { id: 1, topic: "/same", messageEncoding: "json", schemaId: 1, schemaName: "Example", schemaEncoding: "jsonschema", messageCount: "2" },
    { id: 2, topic: "/same", messageEncoding: "json", schemaId: 1, schemaName: "Example", schemaEncoding: "jsonschema", messageCount: "2" }
  ],
  schemas: [{ id: 1, name: "Example", encoding: "jsonschema", text: "{}" }],
  videoStreams: [],
  attachmentCount: 0,
  metadataCount: 0
};

function send(message: HostToWebviewMessage): void {
  void act(() => window.dispatchEvent(new MessageEvent("message", { data: message })));
}

describe("MCAP editor Webview", () => {
  beforeEach(() => {
    postedMessages.splice(0);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test-frame") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts with no topics selected and synchronizes duplicate topic channels", () => {
    render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording });
    const exportButton = screen.getByRole("button", { name: "Export Slice…" });
    expect(exportButton).toBeDisabled();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]!);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(exportButton).toBeEnabled();
  });

  it("disables export when the source changes and posts reload", () => {
    render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording });
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    send({ type: "sourceChanged", requestId: "watch", generation: 1, message: "changed" });
    expect(screen.getByRole("button", { name: "Export Slice…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(postedMessages).toContainEqual(expect.objectContaining({ type: "reloadSource", generation: 1 }));
  });

  it("debounces frame requests and drops an obsolete frame response", () => {
    vi.useFakeTimers();
    const videoRecording: RecordingSummary = {
      ...recording,
      videoStreams: [{ channelId: 9, topic: "/camera" }]
    };
    render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording: videoRecording });
    send({
      type: "videoIndexState",
      requestId: "index",
      generation: 1,
      channelId: 9,
      state: "ready",
      frameCount: 5
    });
    const initialFrameRequest = [...postedMessages].reverse().find(
      (message): message is { type: "requestFrame"; requestId: string } =>
        typeof message === "object" && message !== null && "type" in message && message.type === "requestFrame"
    );
    expect(initialFrameRequest).toBeDefined();

    send({
      type: "frameResult",
      requestId: "obsolete",
      generation: 1,
      channelId: 9,
      frameIndex: 0,
      frameCount: 5,
      logTimeNs: recording.startNs,
      publishTimeNs: recording.startNs,
      sequence: 0,
      captureTimeNs: recording.startNs,
      frameId: "camera",
      format: "png",
      mimeType: "image/png",
      image: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer
    });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    send({
      type: "frameResult",
      requestId: initialFrameRequest!.requestId,
      generation: 1,
      channelId: 9,
      frameIndex: 0,
      frameCount: 5,
      logTimeNs: recording.startNs,
      publishTimeNs: recording.startNs,
      sequence: 0,
      captureTimeNs: recording.startNs,
      frameId: "camera",
      format: "png",
      mimeType: "image/png",
      image: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer
    });
    expect(screen.getByRole("img")).toHaveAttribute("src", "blob:test-frame");

    postedMessages.splice(0);
    const frameSlider = screen.getByRole("slider", { name: "Video frame" });
    fireEvent.change(frameSlider, { target: { value: "1" } });
    fireEvent.change(frameSlider, { target: { value: "3" } });
    void act(() => vi.advanceTimersByTime(79));
    expect(postedMessages).toHaveLength(0);
    void act(() => vi.advanceTimersByTime(1));
    expect(postedMessages).toEqual([
      expect.objectContaining({ type: "requestFrame", generation: 1, frameIndex: 3 })
    ]);
  });

  it("seeks the video to the export handle while the range is dragged", () => {
    vi.useFakeTimers();
    const videoRecording: RecordingSummary = {
      ...recording,
      videoStreams: [{ channelId: 9, topic: "/camera" }]
    };
    render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording: videoRecording });
    send({
      type: "videoIndexState",
      requestId: "index",
      generation: 1,
      channelId: 9,
      state: "ready",
      frameCount: 5
    });
    postedMessages.splice(0);

    const inBoundary = screen.getByRole("slider", { name: "In boundary" });
    fireEvent.pointerDown(inBoundary);
    fireEvent.change(inBoundary, { target: { value: "1700000000001" } });
    fireEvent.change(inBoundary, { target: { value: "1700000000002" } });
    void act(() => vi.advanceTimersByTime(49));
    expect(postedMessages).toHaveLength(0);
    void act(() => vi.advanceTimersByTime(1));
    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: "seekFrame",
        generation: 1,
        timestampNs: "1700000000002000000"
      })
    ]);
  });
});
