import path from "node:path";

import * as vscode from "vscode";

import { McapDocument } from "./mcapDocument";
import { RobotAssetService } from "./robotAssetService";
import {
  parseWebviewMessage,
  type HostToWebviewMessage,
  type RecordingPreferences,
  type WebviewToHostMessage,
  type WorkerFrameResult
} from "./shared/protocol";
import { WorkerOperationError } from "./workerClient";

const VIEW_TYPE = "mcapSlice.editor";
const SELECTED_TOPICS_KEY = "mcapSlice.rememberedExportTopics";
const VIDEO_TOPIC_KEY = "mcapSlice.rememberedVideoTopic";
const JOINT_STATE_TOPIC_KEY = "mcapSlice.rememberedJointStateTopic";

interface EditorSession {
  document: McapDocument;
  panel: vscode.WebviewPanel;
  disposables: vscode.Disposable[];
  selectedVideoChannel?: number;
  selectedJointStateChannel?: number;
  selectedUrdf?: vscode.Uri;
}

class McapEditorProvider implements vscode.CustomReadonlyEditorProvider<McapDocument> {
  readonly #sessions = new Set<EditorSession>();
  readonly #robotAssets: RobotAssetService;
  #activeSession: EditorSession | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.#robotAssets = new RobotAssetService(context);
  }

  public openCustomDocument(uri: vscode.Uri): Promise<McapDocument> {
    if (!isHostFileUri(uri)) {
      throw new Error("MCAP Slice only supports local or remote file-system resources.");
    }
    return Promise.resolve(new McapDocument(uri, this.context.extensionPath));
  }

  public resolveCustomEditor(
    document: McapDocument,
    webviewPanel: vscode.WebviewPanel
  ): void {
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot, this.context.globalStorageUri]
    };
    webviewPanel.webview.html = this.#webviewHtml(webviewPanel.webview, webviewRoot);

    const session: EditorSession = { document, panel: webviewPanel, disposables: [] };
    this.#sessions.add(session);
    if (webviewPanel.active) {
      this.#activeSession = session;
    }

    session.disposables.push(
      webviewPanel.onDidChangeViewState(({ webviewPanel: panel }) => {
        if (panel.active) {
          this.#activeSession = session;
        }
      }),
      webviewPanel.onDidDispose(() => {
        for (const disposable of session.disposables) {
          disposable.dispose();
        }
        this.#sessions.delete(session);
        if (this.#activeSession === session) {
          this.#activeSession = undefined;
        }
      }),
      document.onDidBecomeStale((message) => {
        this.#post(session, { type: "sourceChanged", requestId: "source-watch", generation: document.generation, message });
      }),
      webviewPanel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (!message) {
          this.#postError(session, "message", "The Webview sent an invalid request.", "invalid-message");
          return;
        }
        void this.#handleWebviewMessage(session, message);
      })
    );
  }

  public requestActiveExport(): void {
    const session = this.#activeSession;
    if (session) {
      this.#post(session, {
        type: "requestExport",
        requestId: "editor-command",
        generation: session.document.generation
      });
    }
  }

  public reloadActive(): void {
    if (this.#activeSession) {
      void this.#load(this.#activeSession, "editor-command");
    }
  }

  public selectActiveUrdf(): void {
    if (this.#activeSession) {
      void this.#selectUrdf(this.#activeSession, "editor-command");
    }
  }

  public async clearRobotAssetCache(): Promise<void> {
    await this.#robotAssets.clearCache();
    void vscode.window.showInformationMessage("MCAP Slice robot asset cache cleared.");
  }

  public testState(): { active: boolean; generation?: number; loaded?: boolean; stale?: boolean } {
    const session = this.#activeSession;
    return session
      ? {
          active: true,
          generation: session.document.generation,
          loaded: session.document.recording !== undefined,
          stale: session.document.stale
        }
      : { active: false };
  }

  async #handleWebviewMessage(session: EditorSession, message: WebviewToHostMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          if (session.document.recording && !session.document.stale) {
            this.#post(session, {
              type: "recordingLoaded",
              requestId: message.requestId,
              generation: session.document.generation,
              recording: session.document.recording,
              preferences: this.#recordingPreferences()
            });
          } else {
            await this.#load(session, message.requestId);
          }
          return;
        case "reloadSource":
          await this.#load(session, message.requestId);
          return;
        case "cancelOperation":
          session.document.cancel(message.operationId);
          return;
        case "selectUrdf":
          await this.#selectUrdf(session, message.requestId);
          return;
        case "loadRememberedUrdf":
          await this.#loadRememberedUrdf(session, message.requestId);
          return;
      }

      if (message.generation !== session.document.generation) {
        return;
      }
      if (message.type === "selectVideoStream") {
        await this.#indexVideo(session, message.requestId, message.channelId, message.remember !== false);
      } else if (message.type === "requestFrame") {
        this.#sendFrame(
          session,
          message.requestId,
          await session.document.readFrame(this.#selectedVideoChannel(session), message.frameIndex)
        );
      } else if (message.type === "seekFrame") {
        const channelId = this.#selectedVideoChannel(session);
        const frameIndex = await session.document.seekFrame(channelId, message.timestampNs);
        this.#sendFrame(session, message.requestId, await session.document.readFrame(channelId, frameIndex));
      } else if (message.type === "selectJointStateStream") {
        await this.#indexJointStates(session, message.requestId, message.channelId, message.remember !== false);
      } else if (message.type === "rememberTopicSelection") {
        await this.context.workspaceState.update(
          SELECTED_TOPICS_KEY,
          [...new Set(message.selectedTopics)].sort()
        );
      } else if (message.type === "seekJointState") {
        const result = await session.document.readJointStateAt(
          this.#selectedJointStateChannel(session),
          message.timestampNs
        );
        this.#post(session, {
          type: "jointStateResult",
          requestId: message.requestId,
          generation: session.document.generation,
          ...result
        });
      } else if (message.type === "exportSlice") {
        await this.#export(session, message);
      }
    } catch (error) {
      if (
        message.type === "selectJointStateStream" &&
        (session.selectedJointStateChannel !== message.channelId ||
          session.document.generation !== message.generation)
      ) {
        return;
      }
      if (error instanceof WorkerOperationError && (error.code === "CANCELED" || error.code === "STALE_SESSION")) {
        if (error.code === "CANCELED") {
          this.#post(session, {
            type: "exportState",
            requestId: message.requestId,
            generation: session.document.generation,
            state: "canceled",
            message: "Export canceled"
          });
        }
        return;
      }
      this.#postError(session, message.type, errorMessage(error), message.requestId);
    }
  }

  async #load(session: EditorSession, requestId: string): Promise<void> {
    const nextGeneration = session.document.generation + 1;
    this.#post(session, { type: "loadingState", requestId, generation: nextGeneration, message: "Reading indexed MCAP summary…" });
    try {
      const recording = await session.document.load((state) => {
        this.#post(session, {
          type: "loadingState",
          requestId,
          generation: session.document.generation,
          message: state.message
        });
      });
      this.#post(session, {
        type: "recordingLoaded",
        requestId,
        generation: session.document.generation,
        recording,
        preferences: this.#recordingPreferences()
      });
    } catch (error) {
      this.#postError(session, "load", errorMessage(error), requestId, nextGeneration);
    }
  }

  async #indexVideo(session: EditorSession, requestId: string, channelId: number, remember: boolean): Promise<void> {
    session.selectedVideoChannel = channelId;
    const topic = session.document.recording?.videoStreams.find((stream) => stream.channelId === channelId)?.topic;
    if (remember && topic) {
      await this.context.workspaceState.update(VIDEO_TOPIC_KEY, topic);
    }
    this.#post(session, {
      type: "videoIndexState",
      requestId,
      generation: session.document.generation,
      channelId,
      state: "indexing",
      progress: 0
    });
    const result = await session.document.indexVideo(channelId, (state) => {
      this.#post(session, {
        type: "videoIndexState",
        requestId,
        generation: session.document.generation,
        channelId,
        state: "indexing",
        progress: state.progress
      });
    });
    this.#post(session, {
      type: "videoIndexState",
      requestId,
      generation: session.document.generation,
      channelId,
      state: result.frameCount === 0 ? "empty" : "ready",
      frameCount: result.frameCount,
      firstLogTimeNs: result.firstLogTimeNs,
      lastLogTimeNs: result.lastLogTimeNs,
      progress: 1
    });
  }

  async #indexJointStates(
    session: EditorSession,
    requestId: string,
    channelId: number,
    remember: boolean
  ): Promise<void> {
    session.selectedJointStateChannel = channelId;
    const topic = session.document.recording?.jointStateStreams.find((stream) => stream.channelId === channelId)?.topic;
    if (remember && topic) {
      await this.context.workspaceState.update(JOINT_STATE_TOPIC_KEY, topic);
    }
    const generation = session.document.generation;
    this.#post(session, {
      type: "jointStateIndexState",
      requestId,
      generation: session.document.generation,
      channelId,
      state: "indexing",
      progress: 0
    });
    const result = await session.document.indexJointStates(channelId, (state) => {
      if (session.selectedJointStateChannel !== channelId || session.document.generation !== generation) {
        return;
      }
      this.#post(session, {
        type: "jointStateIndexState",
        requestId,
        generation: session.document.generation,
        channelId,
        state: "indexing",
        progress: state.progress
      });
    });
    if (session.selectedJointStateChannel !== channelId || session.document.generation !== generation) {
      return;
    }
    this.#post(session, {
      type: "jointStateIndexState",
      requestId,
      generation: session.document.generation,
      channelId,
      state: result.messageCount === 0 ? "empty" : "ready",
      messageCount: result.messageCount,
      firstLogTimeNs: result.firstLogTimeNs,
      lastLogTimeNs: result.lastLogTimeNs,
      progress: 1
    });
  }

  async #selectUrdf(session: EditorSession, requestId: string): Promise<void> {
    const remembered = this.#robotAssets.rememberedUrdf();
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: remembered,
      filters: { "URDF robot models": ["urdf"] },
      openLabel: "Load URDF"
    });
    if (selected?.[0]) {
      await this.#loadUrdf(session, requestId, selected[0]);
    }
  }

  async #loadRememberedUrdf(session: EditorSession, requestId: string): Promise<void> {
    const remembered = session.selectedUrdf ?? this.#robotAssets.rememberedUrdf();
    if (!remembered) {
      this.#post(session, {
        type: "robotModelState",
        requestId,
        generation: session.document.generation,
        state: "empty"
      });
      return;
    }
    await this.#loadUrdf(session, requestId, remembered);
  }

  async #loadUrdf(session: EditorSession, requestId: string, uri: vscode.Uri): Promise<void> {
    session.selectedUrdf = uri;
    this.#post(session, {
      type: "robotModelState",
      requestId,
      generation: session.document.generation,
      state: "loading",
      sourceUri: uri.toString(),
      message: `Preparing ${path.basename(uri.fsPath)}…`
    });
    try {
      const prepared = await this.#robotAssets.prepareUrdf(uri, session.panel.webview);
      await this.#robotAssets.rememberUrdf(uri);
      this.#post(session, {
        type: "robotModelState",
        requestId,
        generation: session.document.generation,
        state: "ready",
        ...prepared
      });
    } catch (error) {
      this.#post(session, {
        type: "robotModelState",
        requestId,
        generation: session.document.generation,
        state: "error",
        sourceUri: uri.toString(),
        modelName: path.basename(uri.fsPath),
        message: errorMessage(error)
      });
    }
  }

  #sendFrame(session: EditorSession, requestId: string, frame: WorkerFrameResult): void {
    this.#post(session, {
      type: "frameResult",
      requestId,
      generation: session.document.generation,
      ...frame,
      image: Uint8Array.from(frame.image).buffer
    });
  }

  async #export(session: EditorSession, message: Extract<WebviewToHostMessage, { type: "exportSlice" }>): Promise<void> {
    const recording = session.document.recording;
    if (!recording || session.document.stale) {
      throw new Error("Reload the source recording before exporting.");
    }
    const startNs = BigInt(message.startNs);
    const endNs = BigInt(message.endNs);
    const minimum = (BigInt(recording.startNs) / 1_000_000n) * 1_000_000n;
    const maximum = (BigInt(recording.endNs) / 1_000_000n + 1n) * 1_000_000n;
    if (startNs < minimum || endNs > maximum || startNs >= endNs) {
      throw new Error("The export range must be a valid [In, Out) interval inside the recording.");
    }
    const availableTopics = new Set(recording.channels.map((channel) => channel.topic));
    const selectedTopics = [...new Set(message.selectedTopics)].sort();
    if (selectedTopics.length === 0 || selectedTopics.some((topic) => !availableTopics.has(topic))) {
      throw new Error("Select at least one topic before exporting.");
    }

    this.#post(session, {
      type: "exportState",
      requestId: message.requestId,
      generation: session.document.generation,
      state: "choosingDestination"
    });
    const base = path.parse(recording.sourceName).name;
    const suggestedName = `${base}-slice.mcap`;
    const sourceDirectoryPath = session.document.uri.path.slice(0, session.document.uri.path.lastIndexOf("/") + 1);
    const defaultUri = session.document.uri.with({ path: `${sourceDirectoryPath}${suggestedName}` });
    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "MCAP files": ["mcap"] },
      saveLabel: "Export MCAP Slice"
    });
    if (!destination) {
      this.#post(session, {
        type: "exportState",
        requestId: message.requestId,
        generation: session.document.generation,
        state: "canceled"
      });
      return;
    }
    if (!isHostFileUri(destination)) {
      throw new Error("MCAP Slice can only export to a local or remote file-system path.");
    }
    const normalizedSource = path.resolve(session.document.uri.fsPath);
    const normalizedDestination = path.resolve(destination.fsPath);
    if (
      process.platform === "win32"
        ? normalizedSource.toLowerCase() === normalizedDestination.toLowerCase()
        : normalizedSource === normalizedDestination
    ) {
      throw new Error("MCAP Slice never overwrites the source recording. Choose a different destination.");
    }

    let operationId = "";
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Exporting ${suggestedName}`,
        cancellable: true
      },
      async (progress, token) => {
        let lastProgress = 0;
        token.onCancellationRequested(() => {
          if (operationId) {
            session.document.cancel(operationId);
          }
        });
        const packageJson: unknown = this.context.extension.packageJSON;
        const extensionVersion =
          typeof packageJson === "object" &&
          packageJson !== null &&
          "version" in packageJson &&
          typeof packageJson.version === "string"
            ? packageJson.version
            : "0.1.0";
        const task = session.document.startExport(
          {
            destinationPath: destination.fsPath,
            extensionVersion,
            startNs: message.startNs,
            endNs: message.endNs,
            selectedTopics,
            compression: message.compression
          },
          (state) => {
            const current = Math.round((state.progress ?? lastProgress / 100) * 100);
            progress.report({ increment: Math.max(0, current - lastProgress), message: state.message });
            lastProgress = current;
            this.#post(session, {
              type: "exportState",
              requestId: message.requestId,
              generation: session.document.generation,
              state: "exporting",
              operationId,
              progress: state.progress,
              message: state.message
            });
          }
        );
        operationId = task.operationId;
        await task.promise;
      }
    );
    this.#post(session, {
      type: "exportState",
      requestId: message.requestId,
      generation: session.document.generation,
      state: "success",
      progress: 1,
      message: `Exported ${path.basename(destination.fsPath)}`
    });
    void vscode.window.showInformationMessage(`MCAP Slice exported ${path.basename(destination.fsPath)}.`);
  }

  #selectedVideoChannel(session: EditorSession): number {
    const channelId = session.selectedVideoChannel;
    if (channelId === undefined) {
      throw new Error("Select and index a video stream before requesting a frame.");
    }
    return channelId;
  }

  #selectedJointStateChannel(session: EditorSession): number {
    const channelId = session.selectedJointStateChannel;
    if (channelId === undefined) {
      throw new Error("Select and index a JointState stream before requesting a robot configuration.");
    }
    return channelId;
  }

  #recordingPreferences(): RecordingPreferences {
    const selectedTopics = this.context.workspaceState.get<unknown>(SELECTED_TOPICS_KEY);
    const videoTopic = this.context.workspaceState.get<unknown>(VIDEO_TOPIC_KEY);
    const jointStateTopic = this.context.workspaceState.get<unknown>(JOINT_STATE_TOPIC_KEY);
    return {
      selectedTopics: Array.isArray(selectedTopics)
        ? selectedTopics.filter((topic): topic is string => typeof topic === "string")
        : [],
      videoTopic: typeof videoTopic === "string" ? videoTopic : undefined,
      jointStateTopic: typeof jointStateTopic === "string" ? jointStateTopic : undefined
    };
  }

  #post(session: EditorSession, message: HostToWebviewMessage): void {
    void session.panel.webview.postMessage(message);
  }

  #postError(
    session: EditorSession,
    operation: string,
    message: string,
    requestId: string,
    generation = session.document.generation
  ): void {
    this.#post(session, { type: "operationError", requestId, generation, operation, message });
  }

  #webviewHtml(webview: vscode.Webview, root: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, "app.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, "index.css"));
    const nonce = getNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; connect-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>MCAP Slice</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let index = 0; index < 32; index += 1) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHostFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" || uri.scheme === "vscode-remote";
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new McapEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: false }
    }),
    vscode.commands.registerCommand("mcapSlice.exportSlice", () => provider.requestActiveExport()),
    vscode.commands.registerCommand("mcapSlice.reloadSource", () => provider.reloadActive()),
    vscode.commands.registerCommand("mcapSlice.selectUrdf", () => provider.selectActiveUrdf()),
    vscode.commands.registerCommand("mcapSlice.clearRobotAssetCache", () => provider.clearRobotAssetCache())
  );
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(vscode.commands.registerCommand("mcapSlice._testState", () => provider.testState()));
  }
}

export function deactivate(): void {}
