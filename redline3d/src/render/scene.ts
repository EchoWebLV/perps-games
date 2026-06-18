import * as THREE from "three";

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
}

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#05030d");
  scene.fog = new THREE.Fog("#150a26", 60, 420);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 7.5, 18);
  camera.lookAt(0, 1.2, -28);

  scene.add(new THREE.AmbientLight("#8866ff", 0.7));
  const key = new THREE.DirectionalLight("#ff7ad0", 0.8);
  key.position.set(0, 40, -10);
  scene.add(key);

  addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  return { renderer, scene, camera, clock: new THREE.Clock() };
}
