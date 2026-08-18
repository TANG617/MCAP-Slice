interface VsCodeApi<State = unknown> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;

export interface WebviewState {
  exportSettingsWidth?: number;
  [key: string]: unknown;
}

export const vscode = acquireVsCodeApi<WebviewState>();
