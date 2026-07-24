import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toonify, reclaimToonVariants } from "../render/toon";

// The crate-reveal car viewer. High tier: a live, slowly spinning 3D model in its own small
// WebGL canvas (lazily created on first show). Low tier (weak GPU): one rendered frame shown as
// a static <img> — zero live GPU during the reveal. Mirrors the transient renderer in
// cratebox.ts (low) and the garage turntable (high). `el` is a stable container either way.
export interface RevealCar {
  el: HTMLElement;
  show(opts: { url: string; scale?: number; yaw?: number; tierColor: string }): void;
  clear(): void;
  dispose(): void;
}

const SIZE = 220;
const pr = () => Math.min(2, window.devicePixelRatio || 1);

function makeCam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  c.position.set(2.0, 1.5, 2.6); c.lookAt(0, -0.05, 0);
  return c;
}
// normalize any car to a unit bounding sphere (consistent on-screen size), apply its facing yaw,
// then centre it at the origin.
function frameModel(model: THREE.Object3D, yaw: number): void {
  model.rotation.y = yaw;
  const sph = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
  model.scale.setScalar(1 / (sph.radius || 1));
  const ctr = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  model.position.set(-ctr.x, -ctr.y, -ctr.z);
}
function disposeModel(o: THREE.Object3D): void {
  // reclaim the stashed off-style variants + drop from the style registry (no-op if never toonified)
  for (const mm of reclaimToonVariants(o)) mm.dispose();
  o.traverse((n) => { const m = n as THREE.Mesh; if (m.isMesh) { m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose()); } });
}

export function createRevealCar({ lowTier }: { lowTier: boolean }): RevealCar {
  const loader = new GLTFLoader();
  let loadGen = 0;
  const el = document.createElement("div");
  el.style.cssText = `width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center`;

  if (lowTier) {
    const img = document.createElement("img");
    img.width = SIZE; img.height = SIZE; img.style.cssText = `width:${SIZE}px;height:${SIZE}px;object-fit:contain`;
    el.appendChild(img);
    return {
      el,
      show({ url, yaw = 0, tierColor }) {
        const gen = ++loadGen;
        loader.load(url, (gltf) => {
          if (gen !== loadGen) return;
          const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
          r.setPixelRatio(pr()); r.setSize(SIZE, SIZE, false);
          const pmrem = new THREE.PMREMGenerator(r); const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
          const scene = new THREE.Scene(); scene.environment = env;
          scene.add(new THREE.AmbientLight("#8a78ff", 0.8));
          const kl = new THREE.DirectionalLight("#ffffff", 1.6); kl.position.set(2.2, 3, 2.4); scene.add(kl);
          const rim = new THREE.DirectionalLight(tierColor, 2.2); rim.position.set(-2.4, 1.2, -2.2); scene.add(rim);
          const model = gltf.scene; frameModel(model, yaw); model.rotation.y += -0.5; scene.add(model);
          toonify(model, { outlineWidth: 0.03 }); // cel-shade the reward car (unit-sphere framed)
          r.render(scene, makeCam());
          img.src = r.domElement.toDataURL("image/png");
          disposeModel(model); env.dispose(); r.dispose();
        }, undefined, (err) => console.warn("[reveal-car] GLB failed:", url, err));
      },
      clear() { img.removeAttribute("src"); loadGen++; },
      dispose() {},
    };
  }

  // ---- high tier: lazily-created persistent spinning canvas ----
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene, cam: THREE.PerspectiveCamera, pivot: THREE.Group, rim: THREE.DirectionalLight, env: THREE.Texture;
  let raf = 0, last = 0, current: THREE.Object3D | null = null;

  const ensure = () => {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(pr()); renderer.setSize(SIZE, SIZE, false);
    renderer.domElement.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
    el.appendChild(renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(renderer); env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    cam = makeCam();
    scene = new THREE.Scene(); scene.environment = env;
    scene.add(new THREE.AmbientLight("#8a78ff", 0.8));
    const kl = new THREE.DirectionalLight("#ffffff", 1.6); kl.position.set(2.2, 3, 2.4); scene.add(kl);
    rim = new THREE.DirectionalLight("#ffffff", 2.2); rim.position.set(-2.4, 1.2, -2.2); scene.add(rim);
    pivot = new THREE.Group(); scene.add(pivot);
  };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const drop = () => { if (current) { pivot.remove(current); disposeModel(current); current = null; } };
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    const dt = last ? (t - last) / 1000 : 0; last = t;
    pivot.rotation.y += dt * 0.7;
    renderer!.render(scene, cam);
  };

  return {
    el,
    show({ url, yaw = 0, tierColor }) {
      ensure();
      rim.color.set(tierColor);
      const gen = ++loadGen;
      loader.load(url, (gltf) => {
        if (gen !== loadGen) return;
        drop();
        const model = gltf.scene; frameModel(model, yaw); pivot.add(model); current = model;
        toonify(model, { outlineWidth: 0.03 }); // cel-shade the spinning reward car (unit-sphere framed)
        pivot.rotation.y = -0.5; last = 0; stop(); raf = requestAnimationFrame(loop);
      }, undefined, (err) => console.warn("[reveal-car] GLB failed:", url, err));
    },
    clear() { stop(); if (renderer) drop(); loadGen++; },
    dispose() { stop(); if (renderer) { drop(); env.dispose(); renderer.dispose(); renderer = null; } },
  };
}
