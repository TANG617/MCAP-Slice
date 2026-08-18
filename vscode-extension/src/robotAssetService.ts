import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import * as vscode from "vscode";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_MODEL_BYTES = 1024 * 1024 * 1024;
const MAX_RESOURCES = 512;
const MAX_DEPTH = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const BUNDLE_CACHE_VERSION = 1;
const REMOTE_BUNDLE_REVALIDATE_MS = 24 * 60 * 60 * 1_000;
const REMEMBERED_URDF_KEY = "mcapSlice.rememberedUrdfUri";
const ALLOWED_ORIGINS_KEY = "mcapSlice.allowedRobotAssetOrigins";

class RobotAssetPolicyError extends Error {}

interface LocalAssetSource {
  kind: "local";
  uri: vscode.Uri;
  rootPath: string;
}

interface RemoteAssetSource {
  kind: "remote";
  url: URL;
}

type AssetSource = LocalAssetSource | RemoteAssetSource;

interface LoadedAsset {
  bytes: Uint8Array;
  effectiveSource: AssetSource;
}

interface BundleState {
  bundleDirectory: string;
  visited: Map<string, string>;
  localDependencies: Map<string, LocalDependencyFingerprint>;
  hasRemoteDependencies: boolean;
  totalBytes: number;
  warnings: string[];
}

interface LocalDependencyFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

interface BundleCacheManifest {
  version: number;
  sourceUri: string;
  createdAtMs: number;
  modelName: string;
  warnings: string[];
  assets: string[];
  localDependencies: LocalDependencyFingerprint[];
  hasRemoteDependencies: boolean;
}

interface PreparedBundle {
  modelHash: string;
  modelName: string;
  urdfText: string;
  warnings: string[];
}

interface RemoteCacheMetadata {
  url: string;
  finalUrl: string;
  etag?: string;
  lastModified?: string;
}

export interface PreparedRobotModel {
  modelName: string;
  sourceUri: string;
  urdfText: string;
  warnings: string[];
}

export class RobotAssetService {
  readonly #cacheRoot: string;
  readonly #cacheRootUri: vscode.Uri;
  readonly #sessionAllowedOrigins = new Set<string>();
  readonly #bundleTasks = new Map<string, Promise<PreparedBundle>>();
  #workspacePackages: Promise<Map<string, string[]>> | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.#cacheRootUri = vscode.Uri.joinPath(context.globalStorageUri, "robot-assets");
    this.#cacheRoot = this.#cacheRootUri.fsPath;
  }

  public rememberedUrdf(): vscode.Uri | undefined {
    const value = this.context.workspaceState.get<string>(REMEMBERED_URDF_KEY);
    if (!value) {
      return undefined;
    }
    try {
      return vscode.Uri.parse(value);
    } catch {
      return undefined;
    }
  }

  public async rememberUrdf(uri: vscode.Uri): Promise<void> {
    await this.context.workspaceState.update(REMEMBERED_URDF_KEY, uri.toString());
  }

  public async clearCache(): Promise<void> {
    await rm(this.#cacheRoot, { recursive: true, force: true });
    await mkdir(this.#cacheRoot, { recursive: true });
  }

  public async prepareUrdf(uri: vscode.Uri, webview: vscode.Webview): Promise<PreparedRobotModel> {
    if (!isHostFileUri(uri) || path.extname(uri.fsPath).toLowerCase() !== ".urdf") {
      throw new Error("Select a local or remote-workspace .urdf file.");
    }
    const urdfBytes = await readFile(uri.fsPath);
    if (urdfBytes.byteLength > MAX_FILE_BYTES) {
      throw new Error("The URDF exceeds the 256 MiB per-file limit.");
    }
    const urdfText = new TextDecoder("utf-8", { fatal: true }).decode(urdfBytes);
    const document = parseXml(urdfText, "URDF");
    if (document.documentElement.tagName !== "robot") {
      throw new Error("The selected XML document does not have a <robot> root element.");
    }

    await mkdir(this.#cacheRoot, { recursive: true });
    const modelHash = hash(`${uri.toString()}\0${hash(urdfBytes)}\0${this.#resolutionContext()}`);
    let task = this.#bundleTasks.get(modelHash);
    if (!task) {
      task = this.#loadOrBuildBundle(uri, document, urdfBytes.byteLength, modelHash);
      this.#bundleTasks.set(modelHash, task);
      void task.finally(() => this.#bundleTasks.delete(modelHash)).catch(() => undefined);
    }
    const bundle = await task;
    return {
      modelName: bundle.modelName,
      sourceUri: uri.toString(),
      urdfText: this.#webviewUrdf(bundle.urdfText, bundle.modelHash, webview),
      warnings: bundle.warnings
    };
  }

  async #loadOrBuildBundle(
    uri: vscode.Uri,
    document: Document,
    urdfBytes: number,
    modelHash: string
  ): Promise<PreparedBundle> {
    const bundleDirectory = path.join(this.#cacheRoot, "bundles", modelHash);
    const cached = await this.#readBundleCache(uri, bundleDirectory, modelHash);
    if (cached) {
      return cached;
    }
    await rm(bundleDirectory, { recursive: true, force: true });
    await mkdir(bundleDirectory, { recursive: true });
    const modelRoot = await this.#findModelRoot(path.dirname(uri.fsPath));
    const state: BundleState = {
      bundleDirectory,
      visited: new Map(),
      localDependencies: new Map(),
      hasRemoteDependencies: false,
      totalBytes: urdfBytes,
      warnings: []
    };

    const meshes = [...Array.from(document.getElementsByTagName("mesh"))];
    for (const mesh of meshes) {
      const reference = mesh.getAttribute("filename");
      if (!reference) {
        continue;
      }
      const source = await this.#resolveReference(
        { kind: "local", uri, rootPath: modelRoot },
        reference
      );
      const relativeAsset = await this.#materialize(source, state, 0, true);
      mesh.setAttribute("filename", relativeAsset);
    }

    const rewritten = new XMLSerializer().serializeToString(document, false, undefined, { requireWellFormed: true });
    const modelName = document.documentElement.getAttribute("name") || path.basename(uri.fsPath, path.extname(uri.fsPath));
    const manifest: BundleCacheManifest = {
      version: BUNDLE_CACHE_VERSION,
      sourceUri: uri.toString(),
      createdAtMs: Date.now(),
      modelName,
      warnings: state.warnings,
      assets: [...state.visited.values()].sort(),
      localDependencies: [...state.localDependencies.values()].sort((left, right) => left.path.localeCompare(right.path)),
      hasRemoteDependencies: state.hasRemoteDependencies
    };
    await Promise.all([
      writeFile(path.join(bundleDirectory, "model.urdf"), rewritten),
      writeFile(path.join(bundleDirectory, "manifest.json"), JSON.stringify(manifest))
    ]);
    return {
      modelHash,
      modelName,
      urdfText: rewritten,
      warnings: state.warnings
    };
  }

  async #readBundleCache(
    uri: vscode.Uri,
    bundleDirectory: string,
    modelHash: string
  ): Promise<PreparedBundle | undefined> {
    const manifest = await readJson<BundleCacheManifest>(path.join(bundleDirectory, "manifest.json"));
    const now = Date.now();
    if (
      !manifest ||
      manifest.version !== BUNDLE_CACHE_VERSION ||
      manifest.sourceUri !== uri.toString() ||
      typeof manifest.modelName !== "string" ||
      !Number.isFinite(manifest.createdAtMs) ||
      manifest.createdAtMs > now ||
      !Array.isArray(manifest.warnings) ||
      !manifest.warnings.every((warning) => typeof warning === "string") ||
      !Array.isArray(manifest.assets) ||
      !manifest.assets.every(isBundleAssetName) ||
      !Array.isArray(manifest.localDependencies) ||
      !manifest.localDependencies.every(isLocalDependencyFingerprint) ||
      typeof manifest.hasRemoteDependencies !== "boolean" ||
      (manifest.hasRemoteDependencies && now - manifest.createdAtMs >= REMOTE_BUNDLE_REVALIDATE_MS)
    ) {
      return undefined;
    }
    try {
      for (const dependency of manifest.localDependencies) {
        const current = await stat(dependency.path);
        if (current.size !== dependency.size || current.mtimeMs !== dependency.mtimeMs) {
          return undefined;
        }
      }
      await Promise.all(manifest.assets.map(async (asset) => await stat(path.join(bundleDirectory, asset))));
      const urdfText = await readFile(path.join(bundleDirectory, "model.urdf"), "utf8");
      return {
        modelHash,
        modelName: manifest.modelName,
        urdfText,
        warnings: manifest.warnings
      };
    } catch {
      return undefined;
    }
  }

  #webviewUrdf(urdfText: string, modelHash: string, webview: vscode.Webview): string {
    const document = parseXml(urdfText, "cached URDF");
    for (const mesh of Array.from(document.getElementsByTagName("mesh"))) {
      const reference = mesh.getAttribute("filename");
      if (!reference || reference.includes("/") || reference.includes("\\") || reference === "." || reference === "..") {
        throw new Error("The cached robot bundle contains an invalid mesh reference.");
      }
      const assetUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.#cacheRootUri, "bundles", modelHash, reference)
      );
      mesh.setAttribute("filename", assetUri.toString());
    }
    return new XMLSerializer().serializeToString(document, false, undefined, { requireWellFormed: true });
  }

  #resolutionContext(): string {
    const configuredRoots = vscode.workspace.getConfiguration("mcapSlice").get<string[]>("urdfPackageRoots", []);
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()) ?? [];
    return JSON.stringify({ configuredRoots, workspaceFolders, amentPrefixPath: process.env.AMENT_PREFIX_PATH ?? "" });
  }

  async #materialize(source: AssetSource, state: BundleState, depth: number, isMeshRoot = false): Promise<string> {
    if (depth > MAX_DEPTH) {
      throw new Error(`Robot asset dependency depth exceeds ${MAX_DEPTH}.`);
    }
    const key = sourceKey(source);
    const existing = state.visited.get(key);
    if (existing) {
      return existing;
    }
    if (state.visited.size >= MAX_RESOURCES) {
      throw new Error(`Robot model contains more than ${MAX_RESOURCES} external resources.`);
    }

    const extension = sourceExtension(source);
    if (isMeshRoot && ![".stl", ".dae", ".obj", ".gltf", ".glb"].includes(extension)) {
      throw new Error(`Unsupported URDF mesh format '${extension || "unknown"}' in ${displaySource(source)}.`);
    }
    const relativeName = `${hash(key).slice(0, 24)}${extension || ".bin"}`;
    state.visited.set(key, relativeName);

    if (source.kind === "local") {
      let fileState;
      try {
        fileState = await stat(source.uri.fsPath);
      } catch (error) {
        throw new Error(`Unable to read robot asset ${source.uri.fsPath}: ${errorMessage(error)}`);
      }
      state.localDependencies.set(source.uri.fsPath, {
        path: source.uri.fsPath,
        size: fileState.size,
        mtimeMs: fileState.mtimeMs
      });
    } else {
      state.hasRemoteDependencies = true;
    }

    const loaded = await this.#loadAsset(source, state.warnings);
    if (loaded.bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`${displaySource(source)} exceeds the 256 MiB per-file limit.`);
    }
    state.totalBytes += loaded.bytes.byteLength;
    if (state.totalBytes > MAX_MODEL_BYTES) {
      throw new Error("Robot model dependencies exceed the 1 GiB aggregate limit.");
    }

    const rewritten = await this.#rewriteDependencies(loaded.bytes, loaded.effectiveSource, extension, state, depth);
    await writeFile(path.join(state.bundleDirectory, relativeName), rewritten);
    return relativeName;
  }

  async #rewriteDependencies(
    bytes: Uint8Array,
    source: AssetSource,
    extension: string,
    state: BundleState,
    depth: number
  ): Promise<Uint8Array> {
    if (extension === ".dae") {
      const document = parseXml(decodeText(bytes, source), `DAE ${displaySource(source)}`);
      const references = Array.from(document.getElementsByTagName("init_from"));
      for (const element of references) {
        const reference = element.textContent?.trim();
        if (!isExternalReference(reference)) {
          continue;
        }
        const child = await this.#resolveReference(source, reference);
        element.textContent = await this.#materialize(child, state, depth + 1);
      }
      return new TextEncoder().encode(new XMLSerializer().serializeToString(document));
    }
    if (extension === ".gltf") {
      const json = JSON.parse(decodeText(bytes, source)) as {
        buffers?: Array<{ uri?: string }>;
        images?: Array<{ uri?: string }>;
      };
      for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
        if (!isExternalReference(item.uri)) {
          continue;
        }
        const child = await this.#resolveReference(source, item.uri);
        item.uri = await this.#materialize(child, state, depth + 1);
      }
      return new TextEncoder().encode(JSON.stringify(json));
    }
    if (extension === ".obj") {
      const lines = decodeText(bytes, source).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const match = /^\s*mtllib\s+(.+?)\s*$/i.exec(lines[index]!);
        if (!match) {
          continue;
        }
        const rewritten: string[] = [];
        for (const reference of match[1]!.split(/\s+/).filter(Boolean)) {
          const child = await this.#resolveReference(source, reference);
          rewritten.push(await this.#materialize(child, state, depth + 1));
        }
        lines[index] = `mtllib ${rewritten.join(" ")}`;
      }
      return new TextEncoder().encode(lines.join("\n"));
    }
    if (extension === ".mtl") {
      const lines = decodeText(bytes, source).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const match = /^\s*(map_Ka|map_Kd|map_Ks|map_Ke|map_d|map_Bump|bump|disp|decal|norm)\s+(.+?)\s*$/i.exec(lines[index]!);
        if (!match) {
          continue;
        }
        const reference = mtlTexturePath(match[2]!);
        if (!reference) {
          continue;
        }
        const child = await this.#resolveReference(source, reference);
        const replacement = await this.#materialize(child, state, depth + 1);
        lines[index] = lines[index]!.slice(0, lines[index]!.lastIndexOf(reference)) + replacement;
      }
      return new TextEncoder().encode(lines.join("\n"));
    }
    return bytes;
  }

  async #resolveReference(parent: AssetSource, rawReference: string): Promise<AssetSource> {
    const reference = rawReference.trim();
    if (!reference || reference.startsWith("data:") || reference.startsWith("#")) {
      throw new Error(`Invalid external robot asset reference '${rawReference}'.`);
    }
    if (reference.startsWith("package://")) {
      const match = /^package:\/\/([^/]+)\/(.+)$/.exec(reference);
      if (!match) {
        throw new Error(`Invalid ROS package URI '${reference}'.`);
      }
      return await this.#resolvePackageAsset(match[1]!, match[2]!);
    }
    if (/^https?:\/\//i.test(reference)) {
      return remoteSource(reference);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
      throw new Error(`Unsupported robot asset URI scheme in '${reference}'.`);
    }
    if (path.isAbsolute(reference)) {
      throw new Error(`Absolute local robot asset paths are not allowed: ${reference}`);
    }
    if (parent.kind === "remote") {
      return remoteSource(new URL(reference, parent.url).toString());
    }
    const candidate = path.resolve(path.dirname(parent.uri.fsPath), decodeURIComponent(reference));
    return await localAssetSource(candidate, parent.rootPath);
  }

  async #resolvePackageAsset(packageName: string, relativePath: string): Promise<LocalAssetSource> {
    const configuredRoots = vscode.workspace.getConfiguration("mcapSlice").get<string[]>("urdfPackageRoots", []);
    for (const configured of configuredRoots) {
      const base = path.isAbsolute(configured)
        ? configured
        : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), configured);
      for (const candidate of [base, path.join(base, packageName)]) {
        if (await packageNameAt(candidate) === packageName) {
          const resolved = path.resolve(candidate, relativePath);
          return await localAssetSource(resolved, candidate);
        }
      }
    }

    const workspaceCandidates = (await this.#discoverWorkspacePackages()).get(packageName) ?? [];
    if (workspaceCandidates.length > 1) {
      throw new Error(
        `ROS package '${packageName}' is ambiguous. Configure mcapSlice.urdfPackageRoots. Candidates: ${workspaceCandidates.join(", ")}`
      );
    }
    if (workspaceCandidates[0]) {
      const resolved = path.resolve(workspaceCandidates[0], relativePath);
      return await localAssetSource(resolved, workspaceCandidates[0]);
    }

    const amentCandidates: string[] = [];
    for (const prefix of (process.env.AMENT_PREFIX_PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(prefix, "share", packageName);
      if (await packageNameAt(candidate) === packageName) {
        amentCandidates.push(candidate);
      }
    }
    if (amentCandidates.length > 1) {
      throw new Error(
        `ROS package '${packageName}' is ambiguous. Configure mcapSlice.urdfPackageRoots. Candidates: ${amentCandidates.join(", ")}`
      );
    }
    if (amentCandidates[0]) {
      const resolved = path.resolve(amentCandidates[0], relativePath);
      return await localAssetSource(resolved, amentCandidates[0]);
    }
    throw new Error(`Unable to resolve ROS package '${packageName}'.`);
  }

  #discoverWorkspacePackages(): Promise<Map<string, string[]>> {
    this.#workspacePackages ??= (async () => {
      const result = new Map<string, string[]>();
      const manifests = await vscode.workspace.findFiles(
        "**/package.xml",
        "**/{node_modules,build,install,log,.git}/**",
        2_000
      );
      for (const manifest of manifests) {
        if (manifest.scheme !== "file") {
          continue;
        }
        const packageName = await packageNameAt(path.dirname(manifest.fsPath));
        if (!packageName) {
          continue;
        }
        const entries = result.get(packageName) ?? [];
        entries.push(path.dirname(manifest.fsPath));
        result.set(packageName, entries);
      }
      return result;
    })();
    return this.#workspacePackages;
  }

  async #findModelRoot(startDirectory: string): Promise<string> {
    let current = path.resolve(startDirectory);
    while (true) {
      if (await packageNameAt(current)) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(startDirectory);
      }
      current = parent;
    }
  }

  async #loadAsset(source: AssetSource, warnings: string[]): Promise<LoadedAsset> {
    if (source.kind === "local") {
      try {
        const bytes = await readFile(source.uri.fsPath);
        return { bytes, effectiveSource: source };
      } catch (error) {
        throw new Error(`Unable to read robot asset ${source.uri.fsPath}: ${errorMessage(error)}`);
      }
    }
    const downloaded = await this.#downloadRemote(source.url, warnings);
    return {
      bytes: downloaded.bytes,
      effectiveSource: { kind: "remote", url: new URL(downloaded.finalUrl) }
    };
  }

  async #downloadRemote(url: URL, warnings: string[]): Promise<{ bytes: Uint8Array; finalUrl: string }> {
    await this.#ensureOriginAllowed(url.origin);
    const cacheDirectory = path.join(this.#cacheRoot, "downloads", hash(url.toString()));
    const bodyPath = path.join(cacheDirectory, "body");
    const metadataPath = path.join(cacheDirectory, "metadata.json");
    const cachedMetadata = await readJson<RemoteCacheMetadata>(metadataPath);
    const cachedBytes = cachedMetadata ? await readFileIfExists(bodyPath) : undefined;

    try {
      let current = url;
      let response: Response | undefined;
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        await this.#ensureOriginAllowed(current.origin);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const headers = new Headers();
        if (cachedMetadata?.finalUrl === current.toString()) {
          if (cachedMetadata.etag) {
            headers.set("If-None-Match", cachedMetadata.etag);
          }
          if (cachedMetadata.lastModified) {
            headers.set("If-Modified-Since", cachedMetadata.lastModified);
          }
        }
        try {
          response = await fetch(current, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers,
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
          if (redirects === MAX_REDIRECTS) {
            throw new RobotAssetPolicyError(`HTTPS robot asset exceeded ${MAX_REDIRECTS} redirects.`);
          }
          const location = response.headers.get("location");
          if (!location) {
            throw new RobotAssetPolicyError(`HTTPS robot asset redirect from ${current.origin} has no Location header.`);
          }
          current = secureRemoteUrl(new URL(location, current));
          continue;
        }
        if (response.status === 304 && cachedBytes && cachedMetadata) {
          return { bytes: cachedBytes, finalUrl: cachedMetadata.finalUrl };
        }
        if (!response.ok) {
          const message = `HTTPS robot asset returned ${response.status} ${response.statusText}.`;
          if (response.status < 500 && response.status !== 429) {
            throw new RobotAssetPolicyError(message);
          }
          throw new Error(message);
        }
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > MAX_FILE_BYTES) {
          throw new RobotAssetPolicyError("HTTPS robot asset exceeds the 256 MiB per-file limit.");
        }
        const bytes = await readResponseWithLimit(response, MAX_FILE_BYTES);
        await mkdir(cacheDirectory, { recursive: true });
        await writeFile(bodyPath, bytes);
        const metadata: RemoteCacheMetadata = {
          url: url.toString(),
          finalUrl: current.toString(),
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined
        };
        await writeFile(metadataPath, JSON.stringify(metadata));
        return { bytes, finalUrl: current.toString() };
      }
      throw new Error("HTTPS robot asset redirect handling failed.");
    } catch (error) {
      if (cachedBytes && cachedMetadata && !(error instanceof RobotAssetPolicyError)) {
        warnings.push(`Using cached ${sanitizedUrl(url)} because refresh failed: ${errorMessage(error)}`);
        return { bytes: cachedBytes, finalUrl: cachedMetadata.finalUrl };
      }
      throw new Error(`Unable to download ${sanitizedUrl(url)}: ${errorMessage(error)}`);
    }
  }

  async #ensureOriginAllowed(origin: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new RobotAssetPolicyError("Trust this workspace before loading HTTPS robot assets.");
    }
    const persisted = new Set(this.context.workspaceState.get<string[]>(ALLOWED_ORIGINS_KEY, []));
    if (persisted.has(origin) || this.#sessionAllowedOrigins.has(origin)) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `The selected URDF wants to download robot assets from ${origin}.`,
      { modal: true, detail: "MCAP Slice will download the assets in the extension host without cookies or credentials." },
      "Allow Once",
      "Always Allow in Workspace",
      "Reject"
    );
    if (choice === "Allow Once") {
      this.#sessionAllowedOrigins.add(origin);
      return;
    }
    if (choice === "Always Allow in Workspace") {
      persisted.add(origin);
      await this.context.workspaceState.update(ALLOWED_ORIGINS_KEY, [...persisted].sort());
      return;
    }
    throw new RobotAssetPolicyError(`HTTPS robot assets from ${origin} were not authorized.`);
  }
}

function parseXml(text: string, label: string): Document {
  const errors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(String(message)),
      fatalError: (message) => errors.push(String(message))
    }
  }).parseFromString(text, "application/xml");
  if (errors.length > 0 || !document.documentElement) {
    throw new Error(`${label} XML is invalid: ${errors[0] ?? "missing document element"}`);
  }
  return document;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isBundleAssetName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && path.basename(value) === value && value !== "." && value !== "..";
}

function isLocalDependencyFingerprint(value: unknown): value is LocalDependencyFingerprint {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<LocalDependencyFingerprint>;
  return (
    typeof candidate.path === "string" &&
    path.isAbsolute(candidate.path) &&
    Number.isFinite(candidate.size) &&
    Number.isFinite(candidate.mtimeMs)
  );
}

function sourceKey(source: AssetSource): string {
  return source.kind === "remote" ? source.url.toString() : source.uri.toString();
}

function sourceExtension(source: AssetSource): string {
  const value = source.kind === "remote" ? source.url.pathname : source.uri.fsPath;
  return path.extname(value).toLowerCase();
}

function displaySource(source: AssetSource): string {
  return source.kind === "remote" ? sanitizedUrl(source.url) : source.uri.fsPath;
}

function decodeText(bytes: Uint8Array, source: AssetSource): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${displaySource(source)} is not valid UTF-8: ${errorMessage(error)}`);
  }
}

function remoteSource(value: string): RemoteAssetSource {
  return { kind: "remote", url: secureRemoteUrl(new URL(value)) };
}

function secureRemoteUrl(url: URL): URL {
  if (url.protocol !== "https:") {
    throw new RobotAssetPolicyError(`Only HTTPS robot assets are allowed: ${sanitizedUrl(url)}`);
  }
  if (url.username || url.password) {
    throw new RobotAssetPolicyError("HTTPS robot asset URLs must not contain usernames or passwords.");
  }
  url.hash = "";
  return url;
}

function sanitizedUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function ensureInsideRoot(candidate: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Robot asset path escapes its package root: ${candidate}`);
  }
}

async function localAssetSource(candidate: string, root: string): Promise<LocalAssetSource> {
  ensureInsideRoot(candidate, root);
  try {
    const [resolvedCandidate, resolvedRoot] = await Promise.all([realpath(candidate), realpath(root)]);
    ensureInsideRoot(resolvedCandidate, resolvedRoot);
    return { kind: "local", uri: vscode.Uri.file(resolvedCandidate), rootPath: resolvedRoot };
  } catch (error) {
    throw new Error(`Unable to resolve local robot asset ${candidate}: ${errorMessage(error)}`);
  }
}

function isHostFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" || uri.scheme === "vscode-remote";
}

function isExternalReference(reference: string | undefined): reference is string {
  return Boolean(reference && !reference.startsWith("data:") && !reference.startsWith("#"));
}

function mtlTexturePath(value: string): string | undefined {
  const tokens = value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index]!.toLowerCase();
    const argumentCount = option === "-mm" ? 2 : ["-o", "-s", "-t"].includes(option) ? 3 : 1;
    index += 1 + argumentCount;
  }
  const remaining = tokens.slice(index).join(" ");
  return remaining || undefined;
}

async function packageNameAt(directory: string): Promise<string | undefined> {
  const manifest = path.join(directory, "package.xml");
  try {
    const text = await readFile(manifest, "utf8");
    const document = parseXml(text, manifest);
    return document.getElementsByTagName("name")[0]?.textContent?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readResponseWithLimit(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) {
      break;
    }
    total += item.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RobotAssetPolicyError("HTTPS robot asset exceeds the 256 MiB per-file limit.");
    }
    chunks.push(item.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readFileIfExists(filePath: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(filePath);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
