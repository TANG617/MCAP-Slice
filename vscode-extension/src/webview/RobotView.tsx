import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import URDFLoader, { type URDFJoint, type URDFRobot } from "urdf-loader";

export interface RobotModelData {
  modelName: string;
  urdfText: string;
  warnings: string[];
}

export interface JointConfiguration {
  logTimeNs: string;
  names: string[];
  positions: number[];
}

export interface RobotJointStats {
  matched: number;
  total: number;
  unknown: number;
  missing: number;
  outOfLimit: number;
}

interface SceneState {
  scene: THREE.Scene;
  world: THREE.Group;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  observer: ResizeObserver;
  render: () => void;
}

export function RobotView(props: {
  model?: RobotModelData;
  configuration?: JointConfiguration;
  onStats: (stats: RobotJointStats | undefined) => void;
}): React.JSX.Element {
  const { model, configuration, onStats } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneState | undefined>(undefined);
  const robotRef = useRef<URDFRobot | undefined>(undefined);
  const defaultsRef = useRef<Map<string, number>>(new Map());
  const [renderError, setRenderError] = useState<string>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const themeBackground = themeColor("--vscode-editor-background", "#0d1117");
    const themeForeground = themeColor("--vscode-foreground", "#d4d4d4");
    const stageBackground = themeBackground.clone().lerp(themeForeground, 0.045);
    const accent = themeColor("--vscode-button-background", "#3794ff");
    const gridSecondary = themeBackground.clone().lerp(themeForeground, 0.2);
    const scene = new THREE.Scene();
    scene.background = stageBackground;
    const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 10_000);
    camera.position.set(2, 2, 2);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2;
    scene.add(world);
    scene.add(new THREE.HemisphereLight(0xffffff, stageBackground, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);
    const grid = new THREE.GridHelper(10, 20, accent, gridSecondary);
    scene.add(grid);

    let animationFrame = 0;
    let dirty = true;
    const render = () => {
      dirty = true;
    };
    const animate = () => {
      animationFrame = requestAnimationFrame(animate);
      if (controls.update()) {
        dirty = true;
      }
      if (dirty) {
        renderer.render(scene, camera);
        dirty = false;
      }
    };
    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    controls.addEventListener("change", render);
    sceneRef.current = { scene, world, camera, renderer, controls, observer, render };
    resize();
    animate();
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      controls.dispose();
      if (robotRef.current) {
        disposeObject(robotRef.current);
      }
      renderer.dispose();
      renderer.forceContextLoss();
      sceneRef.current = undefined;
      robotRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const sceneState = sceneRef.current;
    if (!sceneState) {
      return;
    }
    if (robotRef.current) {
      sceneState.world.remove(robotRef.current);
      disposeObject(robotRef.current);
      robotRef.current = undefined;
    }
    defaultsRef.current.clear();
    onStats(undefined);
    setRenderError(undefined);
    if (!model) {
      sceneState.render();
      return;
    }

    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    loader.parseCollision = false;
    loader.loadMeshCb = loadUrdfMesh;
    let disposed = false;
    manager.onError = (url) => {
      if (!disposed) {
        setRenderError(`Unable to load robot asset: ${url}`);
      }
    };
    try {
      const robot = loader.parse(model.urdfText);
      robotRef.current = robot;
      sceneState.world.add(robot);
      for (const [name, joint] of Object.entries(robot.joints)) {
        if (isIndependentJoint(joint)) {
          defaultsRef.current.set(name, joint.jointValue[0] ?? 0);
        }
      }
      const fit = () => {
        if (!disposed) {
          fitCamera(robot, sceneState.camera, sceneState.controls);
          sceneState.render();
        }
      };
      manager.onLoad = fit;
      fit();
      const delayedFit = window.setTimeout(fit, 250);
      return () => {
        disposed = true;
        window.clearTimeout(delayedFit);
        if (robotRef.current === robot) {
          sceneState.world.remove(robot);
          disposeObject(robot);
          robotRef.current = undefined;
        }
      };
    } catch (error) {
      setRenderError(errorMessage(error));
    }
  }, [model, onStats]);

  useEffect(() => {
    const robot = robotRef.current;
    if (!robot) {
      onStats(undefined);
      return;
    }
    if (!configuration) {
      resetJointConfiguration(robot, defaultsRef.current);
      onStats(undefined);
      sceneRef.current?.render();
      return;
    }
    const stats = applyJointConfiguration(
      robot,
      defaultsRef.current,
      configuration.names,
      configuration.positions
    );
    onStats(stats);
    sceneRef.current?.render();
  }, [configuration, model, onStats]);

  return (
    <div className="robot-canvas-shell">
      <canvas ref={canvasRef} aria-label="URDF robot preview" />
      {!model && <div className="robot-canvas-message">Load a URDF to preview the robot.</div>}
      {renderError && <div className="robot-canvas-message robot-canvas-error">{renderError}</div>}
    </div>
  );
}

function themeColor(variable: string, fallback: string): THREE.Color {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  try {
    return new THREE.Color(value || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

export function applyJointConfiguration(
  robot: Pick<URDFRobot, "joints">,
  defaults: ReadonlyMap<string, number>,
  names: readonly string[],
  positions: readonly number[]
): RobotJointStats {
  resetJointConfiguration(robot, defaults);

  const incoming = new Set<string>();
  let matched = 0;
  let unknown = 0;
  let outOfLimit = 0;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const value = positions[index];
    const joint = robot.joints[name];
    if (!joint || value === undefined || !Number.isFinite(value)) {
      unknown += 1;
      continue;
    }
    if (joint.jointType === "fixed") {
      continue;
    }
    incoming.add(name);
    matched += 1;
    if (
      joint.jointType !== "continuous" &&
      joint.limit &&
      (value < joint.limit.lower || value > joint.limit.upper)
    ) {
      outOfLimit += 1;
    }
    setJointValueUnclamped(joint, value);
  }
  const total = defaults.size;
  let missing = 0;
  for (const name of defaults.keys()) {
    if (!incoming.has(name)) {
      missing += 1;
    }
  }
  return { matched, total, unknown, missing, outOfLimit };
}

export function resetJointConfiguration(
  robot: Pick<URDFRobot, "joints">,
  defaults: ReadonlyMap<string, number>
): void {
  for (const [name, value] of defaults) {
    const joint = robot.joints[name];
    if (joint) {
      setJointValueUnclamped(joint, value);
    }
  }
}

function isIndependentJoint(joint: URDFJoint): boolean {
  return joint.jointType !== "fixed" && !("mimicJoint" in joint);
}

function setJointValueUnclamped(joint: URDFJoint, value: number): void {
  const previous = joint.ignoreLimits;
  joint.ignoreLimits = true;
  try {
    joint.setJointValue(value);
  } finally {
    joint.ignoreLimits = previous;
  }
}

function loadUrdfMesh(
  url: string,
  manager: THREE.LoadingManager,
  done: (mesh: THREE.Object3D, error?: Error) => void
): void {
  const extension = extensionFromUrl(url);
  const fail = (error: unknown) => done(undefined as unknown as THREE.Object3D, toError(error));
  if (extension === ".stl") {
    new STLLoader(manager).load(
      url,
      (geometry) => done(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb8c2cc }))),
      undefined,
      fail
    );
    return;
  }
  if (extension === ".dae") {
    new ColladaLoader(manager).load(url, (result) => done(result.scene), undefined, fail);
    return;
  }
  if (extension === ".gltf" || extension === ".glb") {
    new GLTFLoader(manager).load(url, (result) => done(result.scene), undefined, fail);
    return;
  }
  if (extension === ".obj") {
    void loadObj(url, manager).then(done, fail);
    return;
  }
  fail(new Error(`Unsupported URDF mesh format '${extension || "unknown"}'.`));
}

async function loadObj(url: string, manager: THREE.LoadingManager): Promise<THREE.Object3D> {
  manager.itemStart(url);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OBJ request failed with ${response.status}.`);
    }
    const content = await response.text();
    const loader = new OBJLoader(manager);
    const materialMatch = /^\s*mtllib\s+(.+?)\s*$/im.exec(content);
    if (materialMatch) {
      const materialUrl = new URL(materialMatch[1]!.trim().split(/\s+/)[0]!, url).toString();
      const materials = await new MTLLoader(manager).loadAsync(materialUrl);
      materials.preload();
      loader.setMaterials(materials);
    }
    return loader.parse(content);
  } finally {
    manager.itemEnd(url);
  }
}

function extensionFromUrl(value: string): string {
  try {
    return value.startsWith("blob:") ? "" : value.match(/\.[a-z0-9]+(?=$|[?#])/i)?.[0]?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

function fitCamera(robot: THREE.Object3D, camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
  robot.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(robot);
  if (bounds.isEmpty()) {
    return;
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.1);
  controls.target.copy(center);
  camera.near = Math.max(radius / 1_000, 0.001);
  camera.far = Math.max(radius * 100, 100);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(radius * 3));
  camera.updateProjectionMatrix();
  controls.update();
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
    if (!mesh.isMesh) {
      return;
    }
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const properties = material as unknown as Record<string, unknown>;
      for (const value of Object.values(properties)) {
        if (value instanceof THREE.Texture) {
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
