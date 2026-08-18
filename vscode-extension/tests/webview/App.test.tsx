// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostToWebviewMessage, RecordingSummary } from "../../src/shared/protocol";

const postedMessages: unknown[] = [];
let webviewState: Record<string, unknown> | undefined;

vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: (message: unknown) => postedMessages.push(message),
  getState: () => webviewState,
  setState: (state: Record<string, unknown>) => { webviewState = state; }
}));

vi.mock("../../src/webview/RobotView", () => ({
  RobotView: () => <div data-testid="robot-view" />
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
  jointStateStreams: [],
  attachmentCount: 0,
  metadataCount: 0
};

function send(message: HostToWebviewMessage): void {
  void act(() => window.dispatchEvent(new MessageEvent("message", { data: message })));
}

function pointerEvent(type: string, init: MouseEventInit & { pointerId: number }): MouseEvent {
  const event = new MouseEvent(type, init);
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  return event;
}

describe("MCAP editor Webview", () => {
  beforeEach(() => {
    postedMessages.splice(0);
    webviewState = undefined;
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
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: "rememberTopicSelection", generation: 1, selectedTopics: ["/same"] })
    );
  });

  it("restores topic-name preferences across recordings and keeps unavailable stream preferences", () => {
    const preferenceRecording: RecordingSummary = {
      ...recording,
      videoStreams: [
        { channelId: 9, topic: "/camera-a" },
        { channelId: 10, topic: "/camera-b" }
      ],
      jointStateStreams: [
        { channelId: 7, topic: "/joint-a" },
        { channelId: 8, topic: "/joint-b" }
      ]
    };
    const { container } = render(<App />);
    send({
      type: "recordingLoaded",
      requestId: "load",
      generation: 1,
      recording: preferenceRecording,
      preferences: {
        selectedTopics: ["/same", "/not-in-this-file"],
        videoTopic: "/camera-b",
        jointStateTopic: "/joint-b"
      }
    });

    expect(screen.getAllByRole("checkbox")).toEqual([
      expect.objectContaining({ checked: true }),
      expect.objectContaining({ checked: true })
    ]);
    expect(screen.getByRole("combobox", { name: "Video stream" })).toHaveValue("10");
    expect(screen.getByRole("combobox", { name: "JointState stream" })).toHaveValue("8");
    expect(container.querySelector(".topics-card")).not.toHaveAttribute("open");
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: "selectVideoStream", channelId: 10, remember: true })
    );
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: "selectJointStateStream", channelId: 8, remember: true })
    );

    postedMessages.splice(0);
    send({
      type: "recordingLoaded",
      requestId: "next-load",
      generation: 2,
      recording: preferenceRecording,
      preferences: {
        selectedTopics: [],
        videoTopic: "/camera-not-present",
        jointStateTopic: "/joint-not-present"
      }
    });
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: "selectVideoStream", channelId: 9, remember: false })
    );
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: "selectJointStateStream", channelId: 7, remember: false })
    );
  });

  it("places both previews above the export workspace", () => {
    const { container } = render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording });

    const previewGrid = container.querySelector(".preview-grid");
    const exportWorkspace = container.querySelector(".export-workspace");
    expect(previewGrid).not.toBeNull();
    expect(exportWorkspace).not.toBeNull();
    expect(previewGrid!.compareDocumentPosition(exportWorkspace!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previewGrid!.children[0]?.textContent).toContain("Video preview");
    expect(previewGrid!.children[1]?.textContent).toContain("Robot preview");
    expect(exportWorkspace!.querySelector(".export-settings .topics-card")).toHaveAttribute("open");
    expect(exportWorkspace!.querySelector(".compression-card")).not.toHaveAttribute("open");
    expect(exportWorkspace!.querySelector(".details-card")).not.toHaveAttribute("open");
    expect(screen.getByRole("separator", { name: "Resize export settings" })).toHaveAttribute("aria-valuenow", "304");
    expect(exportWorkspace!.querySelector(".export-primary-card .primary")).toHaveTextContent("Export Slice…");
    expect(exportWorkspace!.querySelector(".export-primary-card")).toHaveTextContent("Choose the time range");
    expect(container.querySelector(".document-header button")).toBeNull();
  });

  it("resizes the export settings pane by pointer and keyboard and remembers its width", () => {
    const { container } = render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording });

    const splitter = screen.getByRole("separator", { name: "Resize export settings" });
    Object.defineProperties(splitter, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() }
    });

    fireEvent(splitter, pointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 300 }));
    fireEvent(splitter, pointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: 396 }));
    expect(splitter).toHaveAttribute("aria-valuenow", "400");
    expect(container.querySelector(".export-workspace")).toHaveClass("is-resizing");
    fireEvent(splitter, pointerEvent("pointerup", { bubbles: true, pointerId: 7, clientX: 396 }));
    expect(webviewState).toEqual({ exportSettingsWidth: 400 });
    expect(container.querySelector(".export-workspace")).not.toHaveClass("is-resizing");

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter).toHaveAttribute("aria-valuenow", "416");
    expect(webviewState).toEqual({ exportSettingsWidth: 416 });

    fireEvent.doubleClick(splitter);
    expect(splitter).toHaveAttribute("aria-valuenow", "304");
    expect(webviewState).toEqual({ exportSettingsWidth: 304 });
  });

  it("restores and clamps the remembered export settings width", () => {
    webviewState = { exportSettingsWidth: 440, preserved: "value" };
    const { unmount } = render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording });
    expect(screen.getByRole("separator", { name: "Resize export settings" })).toHaveAttribute("aria-valuenow", "440");
    unmount();

    webviewState = { exportSettingsWidth: 10_000 };
    render(<App />);
    send({ type: "recordingLoaded", requestId: "next-load", generation: 2, recording });
    expect(screen.getByRole("separator", { name: "Resize export settings" })).toHaveAttribute("aria-valuenow", "560");
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

  it("seeks JointState from the shared cursor even when no video stream exists", () => {
    vi.useFakeTimers();
    const jointRecording: RecordingSummary = {
      ...recording,
      jointStateStreams: [{ channelId: 7, topic: "/joint_states" }]
    };
    render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording: jointRecording });
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: "selectJointStateStream", generation: 1, channelId: 7 })
    );
    send({
      type: "jointStateIndexState",
      requestId: "joint-index",
      generation: 1,
      channelId: 7,
      state: "ready",
      messageCount: 10
    });
    postedMessages.splice(0);
    void act(() => vi.advanceTimersByTime(50));
    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: "seekJointState",
        generation: 1,
        timestampNs: recording.startNs
      })
    ]);

    postedMessages.splice(0);
    fireEvent.change(screen.getByRole("slider", { name: "In boundary" }), {
      target: { value: "1700000000002" }
    });
    void act(() => vi.advanceTimersByTime(50));
    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: "seekJointState",
        generation: 1,
        timestampNs: "1700000000002000000"
      })
    ]);
  });

  it("drops a late JointState response after switching topics", () => {
    vi.useFakeTimers();
    const jointRecording: RecordingSummary = {
      ...recording,
      jointStateStreams: [
        { channelId: 7, topic: "/joint_states" },
        { channelId: 8, topic: "/arm/joint_states" }
      ]
    };
    render(<App />);
    send({ type: "recordingLoaded", requestId: "load", generation: 1, recording: jointRecording });
    send({
      type: "jointStateIndexState",
      requestId: "first-index",
      generation: 1,
      channelId: 7,
      state: "ready",
      messageCount: 2
    });
    void act(() => vi.advanceTimersByTime(50));
    const firstSeek = [...postedMessages].reverse().find(
      (message): message is { type: "seekJointState"; requestId: string } =>
        typeof message === "object" && message !== null && "type" in message && message.type === "seekJointState"
    );
    expect(firstSeek).toBeDefined();

    fireEvent.change(screen.getByRole("combobox", { name: "JointState stream" }), { target: { value: "8" } });
    send({
      type: "jointStateResult",
      requestId: firstSeek!.requestId,
      generation: 1,
      channelId: 7,
      state: "ready",
      logTimeNs: recording.startNs,
      publishTimeNs: recording.startNs,
      captureTimeNs: recording.startNs,
      sequence: 1,
      names: ["old"],
      positions: [1]
    });
    expect(screen.queryByText(/^JointState /)).not.toBeInTheDocument();
    expect(postedMessages).toContainEqual(
      expect.objectContaining({ type: "selectJointStateStream", generation: 1, channelId: 8 })
    );
  });
});
