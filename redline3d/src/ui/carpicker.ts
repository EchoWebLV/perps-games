import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** a car's special ability id; drives in-game effects when that card is selected */
export type CarAbility = "laneBet";
export interface CarOption { name: string; url: string; scale?: number; yaw?: number; ability?: CarAbility; }

const MODEL_YAW = Math.PI; // base facing (matches the in-game car); per-card yaw adds to this

const hudDisplayBeforeMenu = new WeakMap<HTMLElement, string>();

export function setHudMenuMode(parent: HTMLElement, menuRoot: HTMLElement, open: boolean): void {
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child === menuRoot) continue;
    if (open) {
      if (!hudDisplayBeforeMenu.has(child)) hudDisplayBeforeMenu.set(child, child.style.display);
      child.style.display = "none";
    } else {
      child.style.display = hudDisplayBeforeMenu.get(child) ?? "";
      hudDisplayBeforeMenu.delete(child);
    }
  }
}

// one card's live-3D state (its own mini-scene, spun on a turntable)
interface Card {
  win: HTMLElement;      // the rect the car renders into (scissor target)
  spinner: HTMLElement;  // loading placeholder, hidden once the GLB is in
  scene: THREE.Scene;
  pivot: THREE.Group;    // model sits centered here; we spin this
  loaded: boolean;
  rot: number;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .ggrid{display:grid;grid-template-columns:1fr 1fr;gap:11px;overflow-y:auto;overflow-x:hidden;
      max-height:min(72vh,560px);padding:4px 4px 6px;-webkit-overflow-scrolling:touch}
    .gcard{position:relative;border-radius:13px;border:1.5px solid transparent;cursor:pointer;
      background:linear-gradient(180deg,rgba(22,17,44,.94),rgba(10,8,22,.94)) padding-box,
        linear-gradient(130deg,#27e7ff,#ff39c0 46%,#8a5bff 72%,#27e7ff) border-box;
      box-shadow:0 7px 20px rgba(0,0,0,.5);overflow:hidden;
      transition:transform .12s ease,box-shadow .2s ease}
    .gcard:active{transform:translateY(1px)}
    .gcard.sel{box-shadow:0 0 0 1px rgba(39,231,255,.55),0 8px 28px rgba(39,231,255,.34)}
    .gcard-win{position:relative;height:104px;
      background:radial-gradient(120% 82% at 50% 96%,rgba(39,231,255,.18),rgba(255,57,192,.07) 52%,transparent 76%)}
    .gcard-ld{position:absolute;inset:0;display:grid;place-items:center}
    .gcard-ld i{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.16);
      border-top-color:var(--cyan);animation:gspin .8s linear infinite}
    @keyframes gspin{to{transform:rotate(360deg)}}
    .gcard-name{padding:8px 6px 10px;text-align:center;color:var(--mut);
      font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.09em;text-transform:uppercase}
    .gcard.sel .gcard-name{color:var(--cyan);text-shadow:0 0 9px rgba(39,231,255,.55)}
  `;
  document.head.appendChild(s);
}

/** Full-screen garage of tradable cards, each with a live, slowly rotating 3D car. */
export function createCarPicker(parent: HTMLElement, cars: CarOption[], onPick: (c: CarOption) => void): void {
  injectStyles();

  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;top:144px;right:max(12px,env(safe-area-inset-right));z-index:8;display:block";

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:9", "display:none",
    "align-items:center", "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(22px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))",
    "background:rgba(0,0,0,.8)", "backdrop-filter:blur(2px)", "pointer-events:auto",
  ].join(";");

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.cssText = [
    "width:min(384px,94vw)", "padding:16px", "display:flex", "flex-direction:column", "gap:12px",
    "background:rgba(12,10,26,.88)", "border-color:rgba(132,150,224,.28)", "pointer-events:auto",
  ].join(";");

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px";
  head.innerHTML = `<span class="lbl">garage · your cards</span>`;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Close menu");
  close.textContent = "x";
  close.style.cssText = "cursor:pointer;color:var(--mut);font:700 16px/1 Chakra Petch,ui-monospace,monospace;padding:3px 5px;border:0;background:transparent";
  head.appendChild(close);
  panel.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "ggrid";
  panel.appendChild(grid);

  // a transparent canvas overlaid on the panel; the gallery renderer paints each
  // card's car into its window rect via scissor. pointer-events:none → card clicks
  // pass straight through to the DOM beneath.
  const glCanvas = document.createElement("canvas");
  // canvas is a replaced element: inset:0 alone resolves width/height to the
  // intrinsic backing size, not the viewport — pin the CSS box explicitly.
  glCanvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:10;pointer-events:none";

  const cards: Card[] = [];
  let selectedEl: HTMLElement | null = null;
  const select = (el: HTMLElement, c: CarOption) => {
    if (selectedEl) selectedEl.classList.remove("sel");
    el.classList.add("sel");
    selectedEl = el;
    onPick(c);
  };

  for (const c of cars) {
    const card = document.createElement("div");
    card.className = "gcard";
    card.innerHTML = `<div class="gcard-win"><div class="gcard-ld"><i></i></div></div><div class="gcard-name">${c.name}</div>`;
    const win = card.querySelector(".gcard-win") as HTMLElement;
    const spinner = card.querySelector(".gcard-ld") as HTMLElement;
    card.onclick = () => select(card, c);
    grid.appendChild(card);

    // each car gets its own lit mini-scene; the model is centered in a pivot we spin
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight("#8a78ff", 0.85));
    const key = new THREE.DirectionalLight("#27e7ff", 1.7); key.position.set(2.2, 3, 2.4); scene.add(key);
    const rim = new THREE.DirectionalLight("#ff39c0", 1.5); rim.position.set(-2.4, 1.2, -2); scene.add(rim);
    const pivot = new THREE.Group();
    scene.add(pivot);
    cards.push({ win, spinner, scene, pivot, loaded: false, rot: -0.5 });
  }
  if (cars[0] && grid.firstElementChild) {
    (grid.firstElementChild as HTMLElement).classList.add("sel");
    selectedEl = grid.firstElementChild as HTMLElement;
  }

  // ---- gallery renderer (lazy: built + models loaded on first open) ----
  let renderer: THREE.WebGLRenderer | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let raf = 0, lastT = 0, started = false;

  const buildGallery = () => {
    if (started) return;
    started = true;
    const r = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.setSize(window.innerWidth, window.innerHeight, false);
    renderer = r;
    camera = new THREE.PerspectiveCamera(32, 1.5, 0.1, 100);
    camera.position.set(1.9, 1.35, 3.6);
    camera.lookAt(0, -0.05, 0);
    // shared environment map → metallic bodies (Cybertruck/Orion) read as metal
    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const loader = new GLTFLoader();
    cars.forEach((c, i) => {
      loader.load(c.url, (gltf) => {
        const model = gltf.scene;
        model.rotation.y = MODEL_YAW + (c.yaw ?? 0);
        // normalize to a unit bounding sphere (so one fixed camera frames every car),
        // then center it on the pivot origin so the turntable spins it in place
        const box = new THREE.Box3().setFromObject(model);
        const sph = box.getBoundingSphere(new THREE.Sphere());
        model.scale.setScalar((1 / (sph.radius || 1)) * (c.scale ?? 1));
        const box2 = new THREE.Box3().setFromObject(model);
        const ctr = box2.getCenter(new THREE.Vector3());
        model.position.set(-ctr.x, -ctr.y, -ctr.z);
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => {
            if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).envMapIntensity = 0.7;
          });
        });
        const card = cards[i];
        card.scene.environment = env;
        card.pivot.add(model);
        card.loaded = true;
        card.spinner.style.display = "none";
      }, undefined, (err) => console.warn("[garage] GLB failed:", c.url, err));
    });
  };

  const tick = (t: number) => {
    raf = requestAnimationFrame(tick);
    if (!renderer || !camera) return;
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
    lastT = t;
    const vh = window.innerHeight;
    const clip = grid.getBoundingClientRect(); // clip cars to the scroll viewport
    renderer.setScissorTest(true);
    for (const card of cards) {
      if (!card.loaded) continue;
      card.rot += dt * 0.6; // slow turntable
      card.pivot.rotation.y = card.rot;
      const r = card.win.getBoundingClientRect();
      const left = Math.max(r.left, clip.left), right = Math.min(r.right, clip.right);
      const top = Math.max(r.top, clip.top), bottom = Math.min(r.bottom, clip.bottom);
      const w = right - left, h = bottom - top;
      if (w <= 0 || h <= 0) continue; // fully scrolled out of the viewport
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      renderer.setViewport(r.left, vh - r.bottom, r.width, r.height); // frame the whole card
      renderer.setScissor(left, vh - bottom, w, h);                   // paint only the visible part
      renderer.render(card.scene, camera);
    }
  };

  addEventListener("resize", () => { renderer?.setSize(window.innerWidth, window.innerHeight, false); });

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.setAttribute("aria-label", "Open menu");
  menuButton.className = "panel";
  menuButton.style.cssText = [
    "width:42px", "height:42px", "padding:0", "display:grid", "place-items:center",
    "border-radius:9px", "cursor:pointer", "background:rgba(12,10,26,.74)",
  ].join(";");
  menuButton.innerHTML = `<span style="display:flex;flex-direction:column;gap:5px;width:18px">
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
  </span>`;

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? "flex" : "none";
    menuButton.style.display = open ? "none" : "grid";
    setHudMenuMode(parent, wrap, open);
    if (open) {
      buildGallery();
      lastT = 0;
      raf = requestAnimationFrame(tick); // run the gallery loop only while it's visible
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  close.onclick = () => setOpen(false);
  menuButton.onclick = () => setOpen(true);
  overlay.onclick = (e) => { if (e.target === overlay) setOpen(false); };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") setOpen(false); });

  overlay.appendChild(panel);
  overlay.appendChild(glCanvas);
  wrap.appendChild(menuButton);
  wrap.appendChild(overlay);
  parent.appendChild(wrap);
}
