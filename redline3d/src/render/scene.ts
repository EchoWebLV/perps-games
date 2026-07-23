import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { pNum, pColor } from "../config/visual-presets";

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
  /** shared main-scene lights, exposed for the DEV Light Lab */
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  /** resize renderer + camera together; pixel ratio is owned by the caller (perf tier) */
  resize(w: number, h: number): void;
}

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#05030d");
  scene.fog = new THREE.Fog(pColor("perps-road", "fogColor", "#150a26"), pNum("perps-road", "fogNear", 60), pNum("perps-road", "fogFar", 420));

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 9, 17);
  camera.lookAt(0, 1.4, -34);

  const ambient = new THREE.AmbientLight(pColor("perps-road", "ambientColor", "#8866ff"), pNum("perps-road", "ambient", 0.7));
  scene.add(ambient);
  const key = new THREE.DirectionalLight(pColor("perps-road", "keyColor", "#ff7ad0"), pNum("perps-road", "key", 0.8));
  key.position.set(0, 40, -10);
  scene.add(key);

  // environment map → reflections on metallic surfaces (the stainless car reads as metal,
  // not a flat blob). Kept subtle so it doesn't wash out the dark synthwave mood.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  function resize(w: number, h: number) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  return { renderer, scene, camera, clock: new THREE.Clock(), ambient, key, resize };
}
