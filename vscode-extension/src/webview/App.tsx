import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Compression,
  HostToWebviewMessage,
  RecordingSummary,
  SchemaSummary,
  WebviewToHostMessage
} from "../shared/protocol";
import { formatNanoseconds, parseTimestampNanoseconds } from "../shared/time";
import {
  RobotView,
  type JointConfiguration,
  type RobotJointStats,
  type RobotModelData
} from "./RobotView";
import { vscode } from "./vscode";

const NS_PER_MS = 1_000_000n;
const DEFAULT_EXPORT_SETTINGS_WIDTH = 304;
const MIN_EXPORT_SETTINGS_WIDTH = 240;
const MAX_EXPORT_SETTINGS_WIDTH = 560;
const EXPORT_SETTINGS_KEYBOARD_STEP = 16;

function clampExportSettingsWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_EXPORT_SETTINGS_WIDTH;
  }
  return Math.min(MAX_EXPORT_SETTINGS_WIDTH, Math.max(MIN_EXPORT_SETTINGS_WIDTH, Math.round(width)));
}

interface VideoState {
  channelId?: number;
  state: "idle" | "indexing" | "ready" | "empty" | "error";
  frameCount: number;
  frameIndex: number;
  progress?: number;
  imageUrl?: string;
  details?: string;
}

interface ExportState {
  state: "idle" | "choosingDestination" | "exporting" | "success" | "canceled" | "error";
  operationId?: string;
  progress?: number;
  message?: string;
}

interface JointStateUiState {
  channelId?: number;
  state: "idle" | "indexing" | "ready" | "empty" | "error";
  messageCount: number;
  progress?: number;
  details?: string;
}

interface RobotModelUiState {
  state: "empty" | "loading" | "ready" | "error";
  model?: RobotModelData;
  sourceUri?: string;
  message?: string;
}

interface ExportSettingsResizeDrag {
  pointerId: number;
  startX: number;
  startWidth: number;
  currentWidth: number;
}

function requestId(): string {
  return globalThis.crypto.randomUUID();
}

type OutgoingWebviewMessage = WebviewToHostMessage extends infer Message
  ? Message extends WebviewToHostMessage
    ? Omit<Message, "requestId"> & { requestId?: string }
    : never
  : never;

function post(message: OutgoingWebviewMessage): string {
  const id = message.requestId ?? requestId();
  vscode.postMessage({ ...message, requestId: id });
  return id;
}

function initialRange(recording: RecordingSummary): [bigint, bigint] {
  const start = (BigInt(recording.startNs) / NS_PER_MS) * NS_PER_MS;
  const end = (BigInt(recording.endNs) / NS_PER_MS + 1n) * NS_PER_MS;
  return [start, end];
}

export function App(): React.JSX.Element {
  const [generation, setGeneration] = useState(0);
  const [recording, setRecording] = useState<RecordingSummary>();
  const [loading, setLoading] = useState("Opening recording…");
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(new Set());
  const [topicsOpen, setTopicsOpen] = useState(true);
  const [exportSettingsWidth, setExportSettingsWidth] = useState(() =>
    clampExportSettingsWidth(vscode.getState()?.exportSettingsWidth ?? DEFAULT_EXPORT_SETTINGS_WIDTH)
  );
  const [resizingExportSettings, setResizingExportSettings] = useState(false);
  const [selectedSchema, setSelectedSchema] = useState<SchemaSummary>();
  const [startNs, setStartNs] = useState(0n);
  const [endNs, setEndNs] = useState(0n);
  const [compression, setCompression] = useState<Compression>("zstd");
  const [video, setVideo] = useState<VideoState>({ state: "idle", frameCount: 0, frameIndex: 0 });
  const [cursorTimeNs, setCursorTimeNs] = useState(0n);
  const [jointState, setJointState] = useState<JointStateUiState>({ state: "idle", messageCount: 0 });
  const [jointConfiguration, setJointConfiguration] = useState<JointConfiguration>();
  const [robotModel, setRobotModel] = useState<RobotModelUiState>({ state: "empty" });
  const [robotStats, setRobotStats] = useState<RobotJointStats>();
  const [exportState, setExportState] = useState<ExportState>({ state: "idle" });
  const latestFrameRequest = useRef<string | undefined>(undefined);
  const pendingFrameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSeekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSeekTimestamp = useRef<bigint | undefined>(undefined);
  const latestJointStateRequest = useRef<string | undefined>(undefined);
  const pendingJointSeekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingJointSeekTimestamp = useRef<bigint | undefined>(undefined);
  const seekJointStateRef = useRef<(timestampNs: bigint) => void>(() => undefined);
  const submitExportRef = useRef<() => void>(() => undefined);
  const generationRef = useRef(0);
  const videoRef = useRef(video);
  const cursorTimeRef = useRef(cursorTimeNs);
  const jointStateRef = useRef(jointState);
  const exportSettingsResizeDrag = useRef<ExportSettingsResizeDrag | undefined>(undefined);
  videoRef.current = video;
  cursorTimeRef.current = cursorTimeNs;
  jointStateRef.current = jointState;

  const canExport =
    recording !== undefined &&
    !stale &&
    !recording.metadataError &&
    selectedTopics.size > 0 &&
    startNs < endNs &&
    exportState.state !== "exporting" &&
    exportState.state !== "choosingDestination";

  const submitExport = useCallback(() => {
    if (!canExport) {
      return;
    }
    setExportState({ state: "choosingDestination" });
    post({
      type: "exportSlice",
      generation: generationRef.current,
      startNs: startNs.toString(),
      endNs: endNs.toString(),
      selectedTopics: [...selectedTopics].sort(),
      compression
    });
  }, [canExport, compression, endNs, selectedTopics, startNs]);
  submitExportRef.current = submitExport;

  const rememberSelectedTopics = useCallback((topics: Set<string>) => {
    setSelectedTopics(topics);
    post({
      type: "rememberTopicSelection",
      generation: generationRef.current,
      selectedTopics: [...topics].sort()
    });
  }, []);

  const commitExportSettingsWidth = useCallback((width: number) => {
    const nextWidth = clampExportSettingsWidth(width);
    setExportSettingsWidth(nextWidth);
    vscode.setState({ ...vscode.getState(), exportSettingsWidth: nextWidth });
  }, []);

  const finishExportSettingsResize = useCallback((target: HTMLDivElement, pointerId: number) => {
    const drag = exportSettingsResizeDrag.current;
    if (!drag || drag.pointerId !== pointerId) {
      return;
    }
    exportSettingsResizeDrag.current = undefined;
    setResizingExportSettings(false);
    commitExportSettingsWidth(drag.currentWidth);
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }, [commitExportSettingsWidth]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebviewMessage>) => {
      const message = event.data;
      if (!message || typeof message.type !== "string") {
        return;
      }
      if (message.generation < generationRef.current) {
        return;
      }
      if (message.generation > generationRef.current) {
        generationRef.current = message.generation;
        setGeneration(message.generation);
      }
      switch (message.type) {
        case "loadingState":
          setLoading(message.message);
          setError(undefined);
          return;
        case "recordingLoaded": {
          if (pendingFrameTimer.current) {
            clearTimeout(pendingFrameTimer.current);
            pendingFrameTimer.current = undefined;
          }
          if (pendingSeekTimer.current) {
            clearTimeout(pendingSeekTimer.current);
            pendingSeekTimer.current = undefined;
          }
          if (pendingJointSeekTimer.current) {
            clearTimeout(pendingJointSeekTimer.current);
            pendingJointSeekTimer.current = undefined;
          }
          pendingSeekTimestamp.current = undefined;
          pendingJointSeekTimestamp.current = undefined;
          latestFrameRequest.current = undefined;
          latestJointStateRequest.current = undefined;
          const [start, end] = initialRange(message.recording);
          setRecording(message.recording);
          setStartNs(start);
          setEndNs(end);
          setCursorTimeNs(start);
          const availableTopics = new Set(message.recording.channels.map((channel) => channel.topic));
          const restoredTopics = new Set(
            (message.preferences?.selectedTopics ?? []).filter((topic) => availableTopics.has(topic))
          );
          setSelectedTopics(restoredTopics);
          setTopicsOpen(restoredTopics.size === 0);
          setSelectedSchema(undefined);
          setStale(false);
          setError(undefined);
          setLoading("");
          setExportState({ state: "idle" });
          setJointState({ state: "idle", messageCount: 0 });
          setJointConfiguration(undefined);
          setRobotStats(undefined);
          setVideo((previous) => {
            if (previous.imageUrl) {
              URL.revokeObjectURL(previous.imageUrl);
            }
            return { state: "idle", frameCount: 0, frameIndex: 0 };
          });
          const preferredVideoStream = message.recording.videoStreams.find(
            (stream) => stream.topic === message.preferences?.videoTopic
          );
          const selectedVideoStream = preferredVideoStream ?? message.recording.videoStreams[0];
          if (selectedVideoStream) {
            setVideo({
              state: "indexing",
              channelId: selectedVideoStream.channelId,
              frameCount: 0,
              frameIndex: 0
            });
            post({
              type: "selectVideoStream",
              generation: message.generation,
              channelId: selectedVideoStream.channelId,
              remember: preferredVideoStream !== undefined || message.preferences?.videoTopic === undefined
            });
          }
          const preferredJointState = message.recording.jointStateStreams.find(
            (stream) => stream.topic === message.preferences?.jointStateTopic
          );
          const selectedJointState = preferredJointState ?? message.recording.jointStateStreams[0];
          if (selectedJointState) {
            setJointState({ state: "indexing", channelId: selectedJointState.channelId, messageCount: 0 });
            post({
              type: "selectJointStateStream",
              generation: message.generation,
              channelId: selectedJointState.channelId,
              remember: preferredJointState !== undefined || message.preferences?.jointStateTopic === undefined
            });
          }
          post({ type: "loadRememberedUrdf", generation: message.generation });
          return;
        }
        case "sourceChanged":
          setStale(true);
          setError(message.message);
          return;
        case "videoIndexState":
          if (message.state === "ready" || message.state === "empty") {
            setError(undefined);
          }
          setVideo((previous) => ({
            ...previous,
            channelId: message.channelId,
            state: message.state,
            frameCount: message.frameCount ?? previous.frameCount,
            frameIndex: 0,
            progress: message.progress,
            details:
              message.state === "ready"
                ? `${message.frameCount?.toLocaleString() ?? 0} frames indexed`
                : message.state === "empty"
                  ? "No frames found"
                  : "Reading video timestamps…"
          }));
          if (message.state === "ready" && (message.frameCount ?? 0) > 0) {
            const id = post({
              type: "requestFrame",
              generation: message.generation,
              frameIndex: 0
            });
            latestFrameRequest.current = id;
          }
          return;
        case "frameResult": {
          if (message.requestId !== latestFrameRequest.current) {
            return;
          }
          const imageUrl = URL.createObjectURL(new Blob([message.image], { type: message.mimeType }));
          setVideo((previous) => {
            if (previous.imageUrl) {
              URL.revokeObjectURL(previous.imageUrl);
            }
            const capture = BigInt(message.captureTimeNs) > 0n ? formatNanoseconds(BigInt(message.captureTimeNs)) : "—";
            return {
              ...previous,
              state: "ready",
              channelId: message.channelId,
              frameCount: message.frameCount,
              frameIndex: message.frameIndex,
              imageUrl,
              details: `${message.format} · ${message.frameId || "no frame id"} · capture ${capture}`
            };
          });
          const frameTime = BigInt(message.logTimeNs);
          setCursorTimeNs(frameTime);
          seekJointStateRef.current(frameTime);
          return;
        }
        case "jointStateIndexState": {
          if (message.state === "ready" || message.state === "empty") {
            setError(undefined);
          }
          const nextJointState: JointStateUiState = {
            channelId: message.channelId,
            state: message.state,
            messageCount: message.messageCount ?? 0,
            progress: message.progress,
            details:
              message.state === "ready"
                ? `${message.messageCount?.toLocaleString() ?? 0} messages indexed`
                : message.state === "empty"
                  ? "No JointState messages found"
                  : "Reading JointState timestamps…"
          };
          jointStateRef.current = nextJointState;
          setJointState(nextJointState);
          if (message.state === "ready" && (message.messageCount ?? 0) > 0) {
            seekJointStateRef.current(cursorTimeRef.current);
          }
          return;
        }
        case "jointStateResult":
          if (message.requestId !== latestJointStateRequest.current) {
            return;
          }
          if (
            message.state === "ready" &&
            message.logTimeNs !== undefined &&
            message.names !== undefined &&
            message.positions !== undefined
          ) {
            setJointConfiguration({
              logTimeNs: message.logTimeNs,
              names: message.names,
              positions: message.positions
            });
          } else {
            setJointConfiguration(undefined);
          }
          return;
        case "robotModelState":
          if (message.state === "ready" && message.modelName && message.urdfText) {
            setRobotModel({
              state: "ready",
              sourceUri: message.sourceUri,
              model: {
                modelName: message.modelName,
                urdfText: message.urdfText,
                warnings: message.warnings ?? []
              }
            });
          } else {
            setRobotModel({
              state: message.state,
              sourceUri: message.sourceUri,
              message: message.message
            });
          }
          setRobotStats(undefined);
          return;
        case "exportState":
          setExportState({
            state: message.state,
            operationId: message.operationId,
            progress: message.progress,
            message: message.message
          });
          return;
        case "operationError":
          if (
            (message.operation === "requestFrame" || message.operation === "seekFrame") &&
            message.requestId !== latestFrameRequest.current
          ) {
            return;
          }
          if (
            message.operation === "seekJointState" &&
            message.requestId !== latestJointStateRequest.current
          ) {
            return;
          }
          setError(message.message);
          if (message.operation === "exportSlice" || message.operation === "export") {
            setExportState({ state: "error", message: message.message });
          } else if (message.operation === "requestFrame" || message.operation === "seekFrame") {
            setVideo((previous) => ({ ...previous, state: "error", details: message.message }));
          } else if (message.operation === "selectJointStateStream" || message.operation === "seekJointState") {
            setJointState((previous) => ({ ...previous, state: "error", details: message.message }));
          }
          return;
        case "requestExport":
          submitExportRef.current();
          return;
      }
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready", generation: generationRef.current });
    return () => {
      window.removeEventListener("message", onMessage);
      if (pendingFrameTimer.current) {
        clearTimeout(pendingFrameTimer.current);
      }
      if (pendingSeekTimer.current) {
        clearTimeout(pendingSeekTimer.current);
      }
      if (pendingJointSeekTimer.current) {
        clearTimeout(pendingJointSeekTimer.current);
      }
      if (videoRef.current.imageUrl) {
        URL.revokeObjectURL(videoRef.current.imageUrl);
      }
    };
  }, []);

  const requestFrame = useCallback((frameIndex: number) => {
    const channelId = videoRef.current.channelId;
    if (channelId === undefined) {
      return;
    }
    setVideo((previous) => ({ ...previous, frameIndex }));
    if (pendingFrameTimer.current) {
      clearTimeout(pendingFrameTimer.current);
    }
    pendingFrameTimer.current = setTimeout(() => {
      const id = post({
        type: "requestFrame",
        generation: generationRef.current,
        frameIndex
      });
      latestFrameRequest.current = id;
      pendingFrameTimer.current = undefined;
    }, 80);
  }, []);

  const seekJointState = useCallback((timestampNs: bigint) => {
    const state = jointStateRef.current;
    if (state.state !== "ready" || state.channelId === undefined) {
      return;
    }
    pendingJointSeekTimestamp.current = timestampNs;
    if (pendingJointSeekTimer.current) {
      return;
    }
    pendingJointSeekTimer.current = setTimeout(() => {
      const timestamp = pendingJointSeekTimestamp.current;
      pendingJointSeekTimer.current = undefined;
      pendingJointSeekTimestamp.current = undefined;
      const current = jointStateRef.current;
      if (timestamp === undefined || current.state !== "ready" || current.channelId === undefined) {
        return;
      }
      const id = post({
        type: "seekJointState",
        generation: generationRef.current,
        timestampNs: timestamp.toString()
      });
      latestJointStateRequest.current = id;
    }, 50);
  }, []);
  seekJointStateRef.current = seekJointState;

  const previewTimestamp = useCallback((timestampNs: bigint) => {
    setCursorTimeNs(timestampNs);
    seekJointStateRef.current(timestampNs);
    if (videoRef.current.state !== "ready" || videoRef.current.channelId === undefined) return;
    pendingSeekTimestamp.current = timestampNs;
    if (pendingSeekTimer.current) {
      return;
    }
    pendingSeekTimer.current = setTimeout(() => {
      const timestamp = pendingSeekTimestamp.current;
      pendingSeekTimer.current = undefined;
      pendingSeekTimestamp.current = undefined;
      if (timestamp === undefined || videoRef.current.state !== "ready") {
        return;
      }
      const id = post({
        type: "seekFrame",
        generation: generationRef.current,
        timestampNs: timestamp.toString()
      });
      latestFrameRequest.current = id;
    }, 50);
  }, []);

  if (!recording) {
    return (
      <main className="center-state">
        <div className="spinner" aria-hidden="true" />
        <h1>MCAP Slice</h1>
        <p>{error ?? loading}</p>
        {error && (
          <button onClick={() => post({ type: "reloadSource", generation })}>Try Again</button>
        )}
      </main>
    );
  }

  const schemasById = new Map(recording.schemas.map((schema) => [schema.id, schema]));
  const sourceStartMs = Number(BigInt(recording.startNs) / NS_PER_MS);
  const sourceEndMs = Number(BigInt(recording.endNs) / NS_PER_MS + 1n);

  return (
    <main className="app-shell">
      <header className="document-header">
        <div>
          <h1>{recording.sourceName}</h1>
          <p>
            {formatBytes(recording.sourceSizeBytes)} · {Number(recording.messageCount).toLocaleString()} messages · {recording.channelCount} channels
          </p>
        </div>
      </header>

      {(stale || recording.attachmentCount > 0 || recording.metadataError || error) && (
        <section className={`notice ${stale || recording.metadataError || error ? "notice-error" : ""}`}>
          <span>{stale ? "The source changed on disk. Reload before continuing." : recording.metadataError ?? error ?? `${recording.attachmentCount} attachment(s) will not be copied during export.`}</span>
          {stale && <button onClick={() => post({ type: "reloadSource", generation })}>Reload</button>}
        </section>
      )}

      <section className="preview-grid" aria-label="Recording previews">
        <VideoPanel
          recording={recording}
          generation={generation}
          startNs={startNs}
          video={video}
          onFrame={requestFrame}
          onVideoChange={(channelId) => {
            if (pendingSeekTimer.current) {
              clearTimeout(pendingSeekTimer.current);
              pendingSeekTimer.current = undefined;
            }
            pendingSeekTimestamp.current = undefined;
            setVideo((previous) => {
              if (previous.imageUrl) URL.revokeObjectURL(previous.imageUrl);
              return { state: "indexing", channelId, frameCount: 0, frameIndex: 0 };
            });
            post({ type: "selectVideoStream", generation, channelId });
          }}
          onSeekToIn={() => previewTimestamp(startNs)}
        />
        <RobotPanel
          recording={recording}
          generation={generation}
          cursorTimeNs={cursorTimeNs}
          jointState={jointState}
          configuration={jointConfiguration}
          robotModel={robotModel}
          stats={robotStats}
          onStats={setRobotStats}
          onSelectUrdf={() => post({ type: "selectUrdf", generation })}
          onRetryUrdf={() => post({ type: "loadRememberedUrdf", generation })}
          onJointStateChange={(channelId) => {
            if (pendingJointSeekTimer.current) {
              clearTimeout(pendingJointSeekTimer.current);
              pendingJointSeekTimer.current = undefined;
            }
            pendingJointSeekTimestamp.current = undefined;
            latestJointStateRequest.current = undefined;
            setError(undefined);
            setJointConfiguration(undefined);
            setJointState({ state: "indexing", channelId, messageCount: 0 });
            post({ type: "selectJointStateStream", generation, channelId });
          }}
        />
      </section>

      <section
        className={`export-workspace${resizingExportSettings ? " is-resizing" : ""}`}
        aria-label="Export settings"
        style={{ "--export-settings-width": `${exportSettingsWidth}px` } as React.CSSProperties}
      >
        <aside id="export-settings-pane" className="export-settings" aria-label="Occasional export settings">
          <details
            className="card disclosure-card topics-card"
            key={`topics-${generation}`}
            open={topicsOpen}
            onToggle={(event) => setTopicsOpen(event.currentTarget.open)}
          >
            <summary>
              <span>Topics</span>
              <span className="summary-value">{selectedTopics.size} selected</span>
            </summary>
            <div className="disclosure-content">
              <div className="settings-toolbar">
                <span>Select topics to include</span>
                <button
                  disabled={selectedTopics.size === 0}
                  onClick={() => rememberSelectedTopics(new Set())}
                >
                  Clear
                </button>
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Topic</th><th>Schema</th><th>Count</th></tr></thead>
                  <tbody>
                    {recording.channels.map((channel) => (
                      <tr
                        key={channel.id}
                        className={selectedSchema?.id === channel.schemaId ? "active-row" : ""}
                        onClick={() => setSelectedSchema(schemasById.get(channel.schemaId))}
                      >
                        <td>
                          <label>
                            <input
                              type="checkbox"
                              checked={selectedTopics.has(channel.topic)}
                              onChange={(event) => {
                                event.stopPropagation();
                                const next = new Set(selectedTopics);
                                if (next.has(channel.topic)) next.delete(channel.topic); else next.add(channel.topic);
                                rememberSelectedTopics(next);
                              }}
                            />
                            <span title={channel.topic}>{channel.topic}</span>
                          </label>
                        </td>
                        <td title={channel.schemaName}>{channel.schemaName || "—"}</td>
                        <td>{Number(channel.messageCount).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </details>

          <details className="card disclosure-card compression-card">
            <summary>
              <span>Compression</span>
              <span className="summary-value">{compression === "none" ? "None" : compression.toUpperCase()}</span>
            </summary>
            <div className="disclosure-content">
              <fieldset>
                <legend>Compression</legend>
                {(["zstd", "lz4", "none"] as Compression[]).map((value) => (
                  <label key={value}><input type="radio" name="compression" checked={compression === value} onChange={() => setCompression(value)} />{value === "none" ? "None" : value.toUpperCase()}</label>
                ))}
              </fieldset>
            </div>
          </details>

          <details className="card disclosure-card details-card">
            <summary>
              <span>Recording details</span>
              <span className="summary-value">{recording.channelCount} channels</span>
            </summary>
            <div className="disclosure-content">
              <dl>
                <dt>Profile</dt><dd>{recording.profile || "—"}</dd>
                <dt>Library</dt><dd>{recording.library || "—"}</dd>
                <dt>Start</dt><dd>{formatNanoseconds(BigInt(recording.startNs))}</dd>
                <dt>End</dt><dd>{formatNanoseconds(BigInt(recording.endNs))}</dd>
                <dt>Metadata</dt><dd>{recording.metadataCount}</dd>
              </dl>
              <h3>Selected topic schema</h3>
              <pre>{selectedSchema?.text ?? "Select a topic to inspect its schema."}</pre>
            </div>
          </details>
        </aside>

        <div
          className="export-splitter"
          role="separator"
          aria-label="Resize export settings"
          aria-controls="export-settings-pane export-primary-pane"
          aria-orientation="vertical"
          aria-valuemin={MIN_EXPORT_SETTINGS_WIDTH}
          aria-valuemax={MAX_EXPORT_SETTINGS_WIDTH}
          aria-valuenow={exportSettingsWidth}
          aria-valuetext={`${exportSettingsWidth} pixels`}
          tabIndex={0}
          title="Drag to resize · Double-click to reset"
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            exportSettingsResizeDrag.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startWidth: exportSettingsWidth,
              currentWidth: exportSettingsWidth
            };
            setResizingExportSettings(true);
          }}
          onPointerMove={(event) => {
            const drag = exportSettingsResizeDrag.current;
            if (!drag || drag.pointerId !== event.pointerId) {
              return;
            }
            const nextWidth = clampExportSettingsWidth(drag.startWidth + event.clientX - drag.startX);
            drag.currentWidth = nextWidth;
            setExportSettingsWidth(nextWidth);
          }}
          onPointerUp={(event) => finishExportSettingsResize(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishExportSettingsResize(event.currentTarget, event.pointerId)}
          onDoubleClick={() => commitExportSettingsWidth(DEFAULT_EXPORT_SETTINGS_WIDTH)}
          onKeyDown={(event) => {
            let nextWidth: number | undefined;
            if (event.key === "ArrowLeft") nextWidth = exportSettingsWidth - EXPORT_SETTINGS_KEYBOARD_STEP;
            if (event.key === "ArrowRight") nextWidth = exportSettingsWidth + EXPORT_SETTINGS_KEYBOARD_STEP;
            if (event.key === "Home") nextWidth = MIN_EXPORT_SETTINGS_WIDTH;
            if (event.key === "End") nextWidth = MAX_EXPORT_SETTINGS_WIDTH;
            if (nextWidth === undefined) {
              return;
            }
            event.preventDefault();
            commitExportSettingsWidth(nextWidth);
          }}
        />

        <section id="export-primary-pane" className="card export-primary-card">
          <div className="export-hero">
            <div>
              <p className="eyebrow">Export slice</p>
              <h2>Choose the time range</h2>
              <p className={selectedTopics.size === 0 ? "export-requirement warning-text" : "export-requirement"}>
                {selectedTopics.size === 0
                  ? "Select at least one topic in Export settings"
                  : `${selectedTopics.size} topic${selectedTopics.size === 1 ? "" : "s"} · ${compression === "none" ? "No compression" : compression.toUpperCase()}`}
              </p>
            </div>
            <button className="primary export-action" disabled={!canExport} onClick={submitExport}>Export Slice…</button>
          </div>

          <div className="range-heading">
            <span>Range</span>
            <button onClick={() => { const [start, end] = initialRange(recording); setStartNs(start); setEndNs(end); }}>Reset</button>
          </div>
          <DualRange
            min={sourceStartMs}
            max={sourceEndMs}
            lower={Number(startNs / NS_PER_MS)}
            upper={Number(endNs / NS_PER_MS)}
            onChange={(lower, upper, preview) => {
              setStartNs(BigInt(lower) * NS_PER_MS);
              setEndNs(BigInt(upper) * NS_PER_MS);
              previewTimestamp(BigInt(preview) * NS_PER_MS);
            }}
            onPreview={(preview) => previewTimestamp(BigInt(preview) * NS_PER_MS)}
          />
          <div className="time-fields">
            <TimestampField label="In" value={startNs} min={BigInt(sourceStartMs) * NS_PER_MS} max={BigInt(sourceEndMs - 1) * NS_PER_MS} onChange={setStartNs} />
            <TimestampField label="Out" value={endNs} min={BigInt(sourceStartMs + 1) * NS_PER_MS} max={BigInt(sourceEndMs) * NS_PER_MS} onChange={setEndNs} />
          </div>
          {exportState.state !== "idle" && (
            <div className="export-progress">
              <progress max={1} value={exportState.progress} />
              <span>{exportState.message ?? exportLabel(exportState.state)}</span>
              {exportState.state === "exporting" && exportState.operationId && (
                <button onClick={() => post({ type: "cancelOperation", generation, operationId: exportState.operationId! })}>Cancel</button>
              )}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function VideoPanel(props: {
  recording: RecordingSummary;
  generation: number;
  startNs: bigint;
  video: VideoState;
  onFrame: (index: number) => void;
  onVideoChange: (channelId: number) => void;
  onSeekToIn: () => void;
}): React.JSX.Element {
  const { recording, video } = props;
  return (
    <section className="card video-card">
      <div className="section-title">
        <h2>Video preview</h2>
        <select
          aria-label="Video stream"
          disabled={recording.videoStreams.length === 0}
          value={video.channelId ?? recording.videoStreams[0]?.channelId ?? ""}
          onChange={(event) => props.onVideoChange(Number(event.target.value))}
        >
          {recording.videoStreams.length === 0 && <option>No supported stream</option>}
          {recording.videoStreams.map((stream) => <option value={stream.channelId} key={stream.channelId}>{stream.topic}</option>)}
        </select>
      </div>
      <div className="video-canvas">
        {video.imageUrl ? <img src={video.imageUrl} alt="Selected compressed camera frame" /> : <span>{video.state === "indexing" ? "Indexing video frames…" : recording.videoStreams.length === 0 ? "No ROS 2 CompressedImage stream found" : video.details ?? "Select a frame"}</span>}
      </div>
      <div className="video-controls">
        <input
          aria-label="Video frame"
          type="range"
          min={0}
          max={Math.max(0, video.frameCount - 1)}
          value={Math.min(video.frameIndex, Math.max(0, video.frameCount - 1))}
          disabled={video.state !== "ready" || video.frameCount === 0}
          onChange={(event) => props.onFrame(Number(event.target.value))}
        />
        <button disabled={video.state !== "ready" || video.frameCount === 0} onClick={props.onSeekToIn}>Seek to In</button>
        <span>{video.frameCount > 0 ? `${video.frameIndex + 1} / ${video.frameCount}` : "0 / 0"}</span>
      </div>
      <p className="frame-details">{video.details ?? "Expected sensor_msgs/msg/CompressedImage with ROS 2 CDR encoding."}</p>
    </section>
  );
}

function RobotPanel(props: {
  recording: RecordingSummary;
  generation: number;
  cursorTimeNs: bigint;
  jointState: JointStateUiState;
  configuration?: JointConfiguration;
  robotModel: RobotModelUiState;
  stats?: RobotJointStats;
  onStats: (stats: RobotJointStats | undefined) => void;
  onSelectUrdf: () => void;
  onRetryUrdf: () => void;
  onJointStateChange: (channelId: number) => void;
}): React.JSX.Element {
  const { recording, jointState, robotModel, stats } = props;
  const status = stats
    ? `${stats.matched}/${stats.total} joints matched · ${stats.unknown} unknown · ${stats.missing} missing · ${stats.outOfLimit} outside limits`
    : jointState.details ?? (recording.jointStateStreams.length === 0 ? "No ROS 2 CDR JointState stream found" : "Select a robot configuration");
  return (
    <section className="card robot-card">
      <div className="section-title robot-title">
        <h2>Robot preview</h2>
        <div className="robot-title-actions">
          {robotModel.state === "error" && robotModel.sourceUri && (
            <button onClick={props.onRetryUrdf}>Retry</button>
          )}
          <button onClick={props.onSelectUrdf}>
            {robotModel.state === "ready" || robotModel.state === "error" ? "Change URDF…" : "Load URDF…"}
          </button>
        </div>
      </div>
      <div className="robot-toolbar">
        <select
          aria-label="JointState stream"
          disabled={recording.jointStateStreams.length === 0 || jointState.state === "indexing"}
          value={jointState.channelId ?? recording.jointStateStreams[0]?.channelId ?? ""}
          onChange={(event) => props.onJointStateChange(Number(event.target.value))}
        >
          {recording.jointStateStreams.length === 0 && <option>No supported stream</option>}
          {recording.jointStateStreams.map((stream) => (
            <option value={stream.channelId} key={stream.channelId}>{stream.topic}</option>
          ))}
        </select>
        <span title={formatNanoseconds(props.cursorTimeNs)}>cursor {formatNanoseconds(props.cursorTimeNs)}</span>
      </div>
      <RobotView model={robotModel.model} configuration={props.configuration} onStats={props.onStats} />
      <p className={`frame-details ${robotModel.state === "error" ? "error-text" : ""}`}>
        {robotModel.state === "loading"
          ? robotModel.message ?? "Preparing URDF…"
          : robotModel.state === "error"
            ? robotModel.message
            : robotModel.model?.modelName ?? "No URDF loaded"}
      </p>
      <p className="frame-details">{status}</p>
      {props.configuration && (
        <p className="frame-details">JointState {formatNanoseconds(BigInt(props.configuration.logTimeNs))}</p>
      )}
      {robotModel.model?.warnings.map((warning) => (
        <p className="frame-details warning-text" key={warning}>{warning}</p>
      ))}
    </section>
  );
}

function DualRange(props: {
  min: number;
  max: number;
  lower: number;
  upper: number;
  onChange: (lower: number, upper: number, preview: number) => void;
  onPreview: (preview: number) => void;
}): React.JSX.Element {
  const span = Math.max(1, props.max - props.min);
  const lowerPercent = ((props.lower - props.min) / span) * 100;
  const upperPercent = ((props.upper - props.min) / span) * 100;
  return (
    <div className="dual-range" style={{ "--lower": `${lowerPercent}%`, "--upper": `${upperPercent}%` } as React.CSSProperties}>
      <div className="range-rail" />
      <input aria-label="In boundary" type="range" min={props.min} max={props.max} value={props.lower} onPointerDown={() => props.onPreview(props.lower)} onChange={(event) => {
        const lower = Math.min(Number(event.target.value), props.upper - 1);
        props.onChange(lower, props.upper, lower);
      }} />
      <input aria-label="Out boundary" type="range" min={props.min} max={props.max} value={props.upper} onPointerDown={() => props.onPreview(props.upper)} onChange={(event) => {
        const upper = Math.max(Number(event.target.value), props.lower + 1);
        props.onChange(props.lower, upper, upper);
      }} />
    </div>
  );
}

function TimestampField(props: { label: string; value: bigint; min: bigint; max: bigint; onChange: (value: bigint) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(() => formatNanoseconds(props.value));
  useEffect(() => setDraft(formatNanoseconds(props.value)), [props.value]);
  const commit = () => {
    const parsed = parseTimestampNanoseconds(draft);
    if (parsed === undefined || parsed < props.min || parsed > props.max) {
      setDraft(formatNanoseconds(props.value));
      return;
    }
    props.onChange(parsed);
    setDraft(formatNanoseconds(parsed));
  };
  return <label><span>{props.label}</span><input value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return `${value} bytes`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function exportLabel(state: ExportState["state"]): string {
  switch (state) {
    case "choosingDestination": return "Choose an export destination…";
    case "exporting": return "Exporting…";
    case "success": return "Export complete";
    case "canceled": return "Export canceled";
    case "error": return "Export failed";
    default: return "";
  }
}
