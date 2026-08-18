import path from "node:path";

import * as vscode from "vscode";

import { McapDocument } from "./mcapDocument";
import {
  parseWebviewMessage,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
  type WorkerFrameResult
} from "./shared/protocol";
import { WorkerOperationError } from "./workerClient";

const VIEW_TYPE = "mcapSlice.editor";

interface EditorSession {
  document: McapDocument;
  panel: vscode.WebviewPanel;
  disposables: vscode.Disposable[];
  selectedVideoChannel?: number;
}

class McapEditorProvider implements vscode.CustomReadonlyEditorProvider<McapDocument> {
  readonly #sessions = new Set<EditorSession>();
  #activeSession: EditorSession | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public openCustomDocument(uri: vscode.Uri): Promise<McapDocument> {
    if (uri.scheme !== "file") {
      throw new Error("MCAP Slice v0.1.0 only supports local or remote file-system resources.");
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
      localResourceRoots: [webviewRoot]
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
              recording: session.document.recording
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
      }

      if (message.generation !== session.document.generation) {
        return;
      }
      if (message.type === "selectVideoStream") {
        await this.#indexVideo(session, message.requestId, message.channelId);
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
      } else if (message.type === "exportSlice") {
        await this.#export(session, message);
      }
    } catch (error) {
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
        recording
      });
    } catch (error) {
      this.#postError(session, "load", errorMessage(error), requestId, nextGeneration);
    }
  }

  async #indexVideo(session: EditorSession, requestId: string, channelId: number): Promise<void> {
    session.selectedVideoChannel = channelId;
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
    if (destination.scheme !== "file") {
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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

export function activate(context: vscode.ExtensionContext): void {
  const provider = new McapEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: false }
    }),
    vscode.commands.registerCommand("mcapSlice.exportSlice", () => provider.requestActiveExport()),
    vscode.commands.registerCommand("mcapSlice.reloadSource", () => provider.reloadActive())
  );
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(vscode.commands.registerCommand("mcapSlice._testState", () => provider.testState()));
  }
}

export function deactivate(): void {}
