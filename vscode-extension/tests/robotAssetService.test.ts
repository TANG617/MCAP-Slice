import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted((): {
  workspaceRoot: string;
  manifests: string[];
  packageRoots: string[];
  trusted: boolean;
  permission: string | undefined;
  prompts: string[];
} => ({
  workspaceRoot: "",
  manifests: [] as string[],
  packageRoots: [] as string[],
  trusted: true,
  permission: "Allow Once",
  prompts: [] as string[]
}));

vi.mock("vscode", () => {
  class FakeUri {
    public readonly scheme: string;
    public readonly fsPath: string;

    public constructor(scheme: string, fsPath: string) {
      this.scheme = scheme;
      this.fsPath = fsPath;
    }

    public toString(): string {
      return this.scheme === "file" ? `file://${this.fsPath}` : `${this.scheme}:${this.fsPath}`;
    }
  }

  return {
    Uri: {
      file: (filePath: string) => new FakeUri("file", path.resolve(filePath)),
      joinPath: (base: FakeUri, ...segments: string[]) => new FakeUri(base.scheme, path.join(base.fsPath, ...segments)),
      parse: (value: string) => {
        const url = new URL(value);
        return new FakeUri(url.protocol.slice(0, -1), decodeURIComponent(url.pathname));
      }
    },
    workspace: {
      get isTrusted() { return mockState.trusted; },
      get workspaceFolders() {
        return mockState.workspaceRoot ? [{ uri: new FakeUri("file", mockState.workspaceRoot) }] : [];
      },
      getConfiguration: () => ({ get: (_key: string, fallback: string[]) => mockState.packageRoots ?? fallback }),
      findFiles: () => Promise.resolve(mockState.manifests.map((filePath) => new FakeUri("file", filePath)))
    },
    window: {
      showWarningMessage: (message: string) => {
        mockState.prompts.push(message);
        return Promise.resolve(mockState.permission);
      }
    }
  };
});

const { RobotAssetService } = await import("../src/robotAssetService");
const vscode = await import("vscode");

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcap-slice-robot-assets-"));
  temporaryDirectories.push(directory);
  return directory;
}

function context(cacheRoot: string): {
  context: ConstructorParameters<typeof RobotAssetService>[0];
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  return {
    values,
    context: {
      globalStorageUri: vscode.Uri.file(cacheRoot),
      workspaceState: {
        get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
        update: (key: string, value: unknown) => {
          values.set(key, value);
          return Promise.resolve();
        }
      }
    } as unknown as ConstructorParameters<typeof RobotAssetService>[0]
  };
}

const webview = {
  asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `vscode-resource:${uri.fsPath}` })
};

beforeEach(() => {
  mockState.workspaceRoot = "";
  mockState.manifests = [];
  mockState.packageRoots = [];
  mockState.trusted = true;
  mockState.permission = "Allow Once";
  mockState.prompts = [];
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("RobotAssetService", () => {
  it("materializes a relative DAE and rewrites its texture dependency", async () => {
    const root = await tempDirectory();
    const robotPackage = path.join(root, "demo_description");
    const urdfDirectory = path.join(robotPackage, "urdf");
    const meshDirectory = path.join(robotPackage, "meshes");
    await mkdir(path.join(meshDirectory, "textures"), { recursive: true });
    await mkdir(urdfDirectory, { recursive: true });
    await writeFile(path.join(robotPackage, "package.xml"), "<package><name>demo_description</name></package>");
    await writeFile(path.join(meshDirectory, "textures", "paint.png"), Uint8Array.from([1, 2, 3]));
    await writeFile(
      path.join(meshDirectory, "robot.dae"),
      "<COLLADA><library_images><image><init_from>textures/paint.png</init_from></image></library_images></COLLADA>"
    );
    const urdfPath = path.join(urdfDirectory, "robot.urdf");
    await writeFile(urdfPath, '<robot name="demo"><link name="base"><visual><geometry><mesh filename="../meshes/robot.dae"/></geometry></visual></link></robot>');

    const { context: extensionContext } = context(path.join(root, "cache"));
    const prepared = await new RobotAssetService(extensionContext).prepareUrdf(
      vscode.Uri.file(urdfPath),
      webview as never
    );
    expect(prepared.modelName).toBe("demo");
    expect(prepared.urdfText).toContain("vscode-resource:");
    const bundlesRoot = path.join(root, "cache", "robot-assets", "bundles");
    const bundle = path.join(bundlesRoot, (await readdir(bundlesRoot))[0]!);
    const daeName = (await readdir(bundle)).find((name) => name.endsWith(".dae"));
    const pngName = (await readdir(bundle)).find((name) => name.endsWith(".png"));
    expect(daeName).toBeDefined();
    expect(await readFile(path.join(bundle, daeName!), "utf8")).toContain(pngName!);
  });

  it("resolves package:// from configured package roots", async () => {
    const root = await tempDirectory();
    const robotPackage = path.join(root, "packages", "demo_description");
    await mkdir(path.join(robotPackage, "meshes"), { recursive: true });
    await writeFile(path.join(robotPackage, "package.xml"), "<package><name>demo_description</name></package>");
    await writeFile(path.join(robotPackage, "meshes", "robot.stl"), "solid demo\nendsolid demo\n");
    const urdfPath = path.join(root, "robot.urdf");
    await writeFile(urdfPath, '<robot name="demo"><link name="base"><visual><geometry><mesh filename="package://demo_description/meshes/robot.stl"/></geometry></visual></link></robot>');
    mockState.packageRoots = [path.join(root, "packages")];

    const { context: extensionContext } = context(path.join(root, "cache"));
    const prepared = await new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(urdfPath), webview as never);
    expect(prepared.urdfText).toMatch(/vscode-resource:.*\.stl/);
  });

  it("rewrites OBJ/MTL textures and accepts a self-contained GLB leaf", async () => {
    const root = await tempDirectory();
    const robotPackage = path.join(root, "description");
    await mkdir(path.join(robotPackage, "meshes", "materials"), { recursive: true });
    await mkdir(path.join(robotPackage, "meshes", "textures"), { recursive: true });
    await mkdir(path.join(robotPackage, "urdf"), { recursive: true });
    await writeFile(path.join(robotPackage, "package.xml"), "<package><name>description</name></package>");
    await writeFile(path.join(robotPackage, "meshes", "robot.obj"), "mtllib materials/robot.mtl\no robot\n");
    await writeFile(path.join(robotPackage, "meshes", "materials", "robot.mtl"), "newmtl paint\nmap_Kd ../textures/paint.png\n");
    await writeFile(path.join(robotPackage, "meshes", "textures", "paint.png"), Uint8Array.from([1, 2, 3]));
    await writeFile(path.join(robotPackage, "meshes", "robot.glb"), Uint8Array.from([0x67, 0x6c, 0x54, 0x46]));
    const urdfPath = path.join(robotPackage, "urdf", "robot.urdf");
    await writeFile(
      urdfPath,
      '<robot name="formats"><link name="base"><visual><geometry><mesh filename="../meshes/robot.obj"/></geometry></visual><visual><geometry><mesh filename="../meshes/robot.glb"/></geometry></visual></link></robot>'
    );

    const { context: extensionContext } = context(path.join(root, "cache"));
    await new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(urdfPath), webview as never);
    const bundlesRoot = path.join(root, "cache", "robot-assets", "bundles");
    const bundle = path.join(bundlesRoot, (await readdir(bundlesRoot))[0]!);
    const names = await readdir(bundle);
    const objName = names.find((name) => name.endsWith(".obj"));
    const mtlName = names.find((name) => name.endsWith(".mtl"));
    const pngName = names.find((name) => name.endsWith(".png"));
    expect(names.some((name) => name.endsWith(".glb"))).toBe(true);
    expect(await readFile(path.join(bundle, objName!), "utf8")).toContain(mtlName!);
    expect(await readFile(path.join(bundle, mtlName!), "utf8")).toContain(pngName!);
  });

  it("rejects ambiguous workspace packages unless a configured root selects one", async () => {
    const root = await tempDirectory();
    const urdfPath = path.join(root, "robot.urdf");
    await writeFile(urdfPath, '<robot name="demo"><link name="base"><visual><geometry><mesh filename="package://duplicate/meshes/robot.stl"/></geometry></visual></link></robot>');
    for (const name of ["first", "second"]) {
      const packageRoot = path.join(root, name);
      await mkdir(path.join(packageRoot, "meshes"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.xml"), "<package><name>duplicate</name></package>");
      await writeFile(path.join(packageRoot, "meshes", "robot.stl"), "solid demo\nendsolid demo\n");
      mockState.manifests.push(path.join(packageRoot, "package.xml"));
    }

    const { context: extensionContext } = context(path.join(root, "cache"));
    await expect(
      new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(urdfPath), webview as never)
    ).rejects.toThrow("is ambiguous");
  });

  it("downloads HTTPS glTF dependencies through the extension host", async () => {
    const root = await tempDirectory();
    const urdfPath = path.join(root, "robot.urdf");
    await writeFile(urdfPath, '<robot name="remote"><link name="base"><visual><geometry><mesh filename="https://assets.example/robot/model.gltf"/></geometry></visual></link></robot>');
    const responses = new Map<string, Response>([
      ["https://assets.example/robot/model.gltf", new Response(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "model.bin" }], images: [{ uri: "paint.png" }] }), { headers: { etag: "one" } })],
      ["https://assets.example/robot/model.bin", new Response(Uint8Array.from([1, 2, 3]))],
      ["https://assets.example/robot/paint.png", new Response(Uint8Array.from([4, 5, 6]))]
    ]);
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const inputUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const response = responses.get(inputUrl);
      if (!response) throw new Error(`Unexpected URL ${inputUrl}`);
      return Promise.resolve(response.clone());
    });
    vi.stubGlobal("fetch", fetchMock);

    const { context: extensionContext } = context(path.join(root, "cache"));
    const prepared = await new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(urdfPath), webview as never);
    expect(prepared.urdfText).toMatch(/vscode-resource:.*\.gltf/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockState.prompts).toHaveLength(1);
    const bundlesRoot = path.join(root, "cache", "robot-assets", "bundles");
    const bundle = path.join(bundlesRoot, (await readdir(bundlesRoot))[0]!);
    const gltfName = (await readdir(bundle)).find((name) => name.endsWith(".gltf"));
    const gltf = JSON.parse(await readFile(path.join(bundle, gltfName!), "utf8")) as { buffers: Array<{ uri: string }>; images: Array<{ uri: string }> };
    expect(gltf.buffers[0]!.uri).toMatch(/\.bin$/);
    expect(gltf.images[0]!.uri).toMatch(/\.png$/);
  });

  it("reuses a prepared HTTPS bundle across editor sessions without another request", async () => {
    const root = await tempDirectory();
    const urdfPath = path.join(root, "robot.urdf");
    await writeFile(urdfPath, '<robot name="cached"><link name="base"><visual><geometry><mesh filename="https://assets.example/robot.stl"/></geometry></visual></link></robot>');
    const fetchMock = vi.fn(() => Promise.resolve(new Response("solid cached\nendsolid cached\n")));
    vi.stubGlobal("fetch", fetchMock);

    const { context: extensionContext } = context(path.join(root, "cache"));
    const first = await new RobotAssetService(extensionContext).prepareUrdf(
      vscode.Uri.file(urdfPath),
      webview as never
    );
    const second = await new RobotAssetService(extensionContext).prepareUrdf(
      vscode.Uri.file(urdfPath),
      webview as never
    );

    expect(first.urdfText).toContain("vscode-resource:");
    expect(second.urdfText).toBe(first.urdfText);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockState.prompts).toHaveLength(1);
  });

  it("rebuilds a bundle when a local mesh dependency changes", async () => {
    const root = await tempDirectory();
    const meshPath = path.join(root, "robot.stl");
    const urdfPath = path.join(root, "robot.urdf");
    await writeFile(meshPath, "solid first\nendsolid first\n");
    await writeFile(urdfPath, '<robot name="local"><link name="base"><visual><geometry><mesh filename="robot.stl"/></geometry></visual></link></robot>');
    const cacheRoot = path.join(root, "cache");
    const { context: extensionContext } = context(cacheRoot);
    await new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(urdfPath), webview as never);

    await writeFile(meshPath, "solid changed-and-longer\nendsolid changed-and-longer\n");
    await new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(urdfPath), webview as never);
    const bundlesRoot = path.join(cacheRoot, "robot-assets", "bundles");
    const bundle = path.join(bundlesRoot, (await readdir(bundlesRoot))[0]!);
    const stlName = (await readdir(bundle)).find((name) => name.endsWith(".stl"));
    expect(await readFile(path.join(bundle, stlName!), "utf8")).toContain("changed-and-longer");
  });

  it("uses a conditionally refreshed HTTPS cache only for transient failures", async () => {
    const root = await tempDirectory();
    const urdfPath = path.join(root, "robot.urdf");
    await writeFile(urdfPath, '<robot name="remote"><link name="base"><visual><geometry><mesh filename="https://assets.example/robot.stl"/></geometry></visual></link></robot>');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("solid cached\nendsolid cached\n", { headers: { etag: '"cached"' } }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const { context: extensionContext } = context(path.join(root, "cache"));
    const service = new RobotAssetService(extensionContext);
    await service.prepareUrdf(vscode.Uri.file(urdfPath), webview as never);
    await rm(path.join(root, "cache", "robot-assets", "bundles"), { recursive: true, force: true });
    const cached = await service.prepareUrdf(vscode.Uri.file(urdfPath), webview as never);
    expect(cached.warnings).toHaveLength(1);
    expect(cached.warnings[0]).toContain("Using cached");
    const secondOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((secondOptions.headers as Headers).get("If-None-Match")).toBe('"cached"');
    expect(mockState.prompts).toHaveLength(1);
  });

  it("rejects path escapes and HTTPS redirects to HTTP", async () => {
    const root = await tempDirectory();
    const modelDirectory = path.join(root, "model");
    await mkdir(modelDirectory);
    await writeFile(path.join(root, "outside.stl"), "solid outside\nendsolid outside\n");
    const escapingUrdf = path.join(modelDirectory, "escaping.urdf");
    await writeFile(escapingUrdf, '<robot name="bad"><link name="base"><visual><geometry><mesh filename="../outside.stl"/></geometry></visual></link></robot>');
    const { context: extensionContext } = context(path.join(root, "cache"));
    await expect(
      new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(escapingUrdf), webview as never)
    ).rejects.toThrow("escapes its package root");

    const remoteUrdf = path.join(modelDirectory, "remote.urdf");
    await writeFile(remoteUrdf, '<robot name="bad"><link name="base"><visual><geometry><mesh filename="https://assets.example/model.stl"/></geometry></visual></link></robot>');
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 302, headers: { location: "http://assets.example/model.stl" } }))));
    await expect(
      new RobotAssetService(extensionContext).prepareUrdf(vscode.Uri.file(remoteUrdf), webview as never)
    ).rejects.toThrow("Only HTTPS robot assets are allowed");
  });

  it.skipIf(!process.env.MCAP_SLICE_REAL_URDF)(
    "materializes a real HTTPS-mesh URDF through the host asset bundle",
    async () => {
      const cacheRoot = await tempDirectory();
      const realUrdf = process.env.MCAP_SLICE_REAL_URDF!;
      const { context: extensionContext } = context(path.join(cacheRoot, "cache"));
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const prepared = await new RobotAssetService(extensionContext).prepareUrdf(
        vscode.Uri.file(realUrdf),
        webview as never
      );
      const requestCountAfterBuild = fetchSpy.mock.calls.length;
      const cached = await new RobotAssetService(extensionContext).prepareUrdf(
        vscode.Uri.file(realUrdf),
        webview as never
      );
      expect(prepared.urdfText).not.toContain("https://");
      expect(prepared.urdfText).toContain("vscode-resource:");
      expect(cached.urdfText).toBe(prepared.urdfText);
      expect(fetchSpy).toHaveBeenCalledTimes(requestCountAfterBuild);
      const [{ default: URDFLoader }, { Group }] = await Promise.all([
        import("urdf-loader"),
        import("three")
      ]);
      const browserWindow = new JSDOM("").window;
      vi.stubGlobal("DOMParser", browserWindow.DOMParser);
      vi.stubGlobal("Document", browserWindow.Document);
      vi.stubGlobal("Element", browserWindow.Element);
      const loader = new URDFLoader();
      loader.loadMeshCb = (_asset, _manager, done) => done(new Group());
      const robot = loader.parse(prepared.urdfText);
      expect(Object.keys(robot.joints).length).toBeGreaterThan(20);
      expect(robot.joints.joint_hand1_link_1_2?.mimicJoints.length).toBeGreaterThan(0);
      const bundlesRoot = path.join(cacheRoot, "cache", "robot-assets", "bundles");
      const bundle = path.join(bundlesRoot, (await readdir(bundlesRoot))[0]!);
      expect((await readdir(bundle)).length).toBeGreaterThan(10);
      expect(mockState.prompts).toHaveLength(1);
    },
    10 * 60_000
  );
});
