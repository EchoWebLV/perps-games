import * as THREE from "three";
import type { Track } from "./buildings/types";

/**
 * Aurora-dawn backdrop for the lobby (the strip). A deliberately DARK sky: a near-black
 * teal/mauve gradient dome, faint drifting aurora curtains, and a sparse starfield — a subtle
 * atmospheric glow over the void, not a bright scene. Everything is `fog:false` (the global fog
 * would fade it to dark purple by 420u) and lives in one group added to the lobby, so the race
 * world is untouched.
 *
 * DIAL / KILL-SWITCH: opacity is a single 0..1 knob. 0 = the old black void, 1 = full strength.
 * It ships LOW by default (see DEFAULT_OPACITY) and persists to localStorage. Live-tweakable from
 * the console via `window.__backdrop`:
 *   __backdrop.setOpacity(0.5)   // strengthen
 *   __backdrop.black()           // back to pure black
 *   __backdrop.show()            // restore
 * To change the baked-in default, edit DEFAULT_OPACITY below (set 0 to ship black by default).
 */
export interface LobbyBackdrop {
  group: THREE.Group;
  animate(t: number): void;
  /** 0 = black void, 1 = full strength. Persisted. */
  setOpacity(x: number): void;
  /** hard on/off (persists opacity 0 when off, restores the last strength when on) */
  setVisible(on: boolean): void;
  current(): number;
}

const STORAGE_KEY = "raider.bgOpacity";
const DEFAULT_OPACITY = 0.35; // ← ships low + dark; set 0 to ship the black void by default

const DOME_R = 800;

// very-dark dawn gradient, sampled by normalized height t = y/R in [-1, 1] (−1 below, 0 horizon, 1 zenith)
const SKY_STOPS: Array<[number, number]> = [
  [-1.0, 0x010204],
  [-0.05, 0x04070c],
  [0.0, 0x241426], // faint mauve horizon hint (kept dark)
  [0.12, 0x0c1320], // dark indigo
  [0.45, 0x081420], // dark teal-navy
  [1.0, 0x03060e], // near-black zenith
];
const _tmp = new THREE.Color();
function sampleSky(t: number, out: THREE.Color): void {
  const s = SKY_STOPS;
  if (t <= s[0][0]) { out.setHex(s[0][1]); return; }
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i][0]) {
      const [t0, c0] = s[i - 1];
      const [t1, c1] = s[i];
      const f = (t - t0) / (t1 - t0);
      out.setHex(c0).lerp(_tmp.setHex(c1), f);
      return;
    }
  }
  out.setHex(s[s.length - 1][1]);
}

// soft aurora curtains: blurred vertical gradient columns in cool dawn hues, tiled around the sky
function auroraTexture(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  const cols = ["#2ee6a6", "#27e7ff", "#6affb0", "#ff8fb0", "#3affd0"];
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  g.filter = "blur(7px)"; // soften the column edges into curtains
  for (let i = 0; i < 16; i++) {
    const x = rnd() * c.width;
    const w = 40 + rnd() * 90;
    const col = cols[Math.floor(rnd() * cols.length)];
    const top = 20 + rnd() * 90;
    const bot = 250 + rnd() * 190;
    const grd = g.createLinearGradient(0, top, 0, bot);
    grd.addColorStop(0, "rgba(0,0,0,0)");
    grd.addColorStop(0.4, col);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.globalAlpha = 0.16 + rnd() * 0.2;
    g.fillStyle = grd;
    g.fillRect(x - w / 2, 0, w, c.height);
  }
  g.filter = "none";
  g.globalAlpha = 1;
  return c;
}

export function buildLobbyBackdrop(track: Track): LobbyBackdrop {
  const group = new THREE.Group();

  // track each dimmable so setOpacity can scale it from a remembered base
  const dimmables: Array<{ set(x: number): void }> = [];

  // ---- 1. gradient sky dome (inside-out sphere, vertex-coloured very-dark dawn) ----
  const domeGeo = track(new THREE.SphereGeometry(DOME_R, 32, 24));
  const pos = domeGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    sampleSky(pos.getY(i) / DOME_R, col);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  domeGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const domeMat = track(new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, transparent: true,
  }));
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -20;
  group.add(dome);
  dimmables.push({ set: (x) => { domeMat.opacity = x; } });

  // ---- 2. faint stars, high in the sky ----
  const STAR_N = 260;
  const starGeo = track(new THREE.BufferGeometry());
  const sp = new Float32Array(STAR_N * 3);
  let ss = 7919;
  const srnd = () => { ss = (ss * 1103515245 + 12345) & 0x7fffffff; return ss / 0x7fffffff; };
  for (let i = 0; i < STAR_N; i++) {
    const th = srnd() * Math.PI * 2;
    const ph = srnd() * 0.5 + 0.06; // upper hemisphere only
    const r = 700;
    sp[i * 3] = r * Math.cos(ph) * Math.cos(th);
    sp[i * 3 + 1] = r * Math.sin(ph);
    sp[i * 3 + 2] = r * Math.cos(ph) * Math.sin(th);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  const starMat = track(new THREE.PointsMaterial({
    color: 0xbfe8ff, size: 2, sizeAttenuation: false,
    transparent: true, opacity: 0.7, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -16;
  const starField = new THREE.Group(); starField.add(stars); group.add(starField);
  dimmables.push({ set: (x) => { starMat.opacity = 0.7 * x; } });

  // ---- 3. aurora curtains: an additive band wrapping the sky, gently drifting ----
  const auroraTex = track(new THREE.CanvasTexture(auroraTexture()));
  auroraTex.wrapS = THREE.RepeatWrapping;
  auroraTex.repeat.set(2, 1);
  const auroraGeo = track(new THREE.CylinderGeometry(520, 520, 320, 48, 1, true));
  const auroraMat = track(new THREE.MeshBasicMaterial({
    map: auroraTex, side: THREE.BackSide, transparent: true, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  const aurora = new THREE.Mesh(auroraGeo, auroraMat);
  aurora.position.y = 150;
  aurora.renderOrder = -12;
  group.add(aurora);
  const AURORA_BASE = 0.9;
  dimmables.push({ set: (x) => { auroraMat.opacity = AURORA_BASE * x; } });

  // ---- cool dawn fill light (scales with the dial so "black" is truly neutral) ----
  const cool = new THREE.HemisphereLight(0x1c7a6a, 0x0a1420, 0.2);
  group.add(cool);
  dimmables.push({ set: (x) => { cool.intensity = 0.2 * x; } });

  // ---- opacity dial + persistence ----
  let opacity = DEFAULT_OPACITY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw != null) { const v = parseFloat(raw); if (Number.isFinite(v)) opacity = Math.min(1, Math.max(0, v)); }
  } catch { /* private mode — just use the default */ }
  let lastNonZero = opacity > 0 ? opacity : DEFAULT_OPACITY || 1;

  function apply(x: number, persist = true): void {
    opacity = Math.min(1, Math.max(0, x));
    if (opacity > 0) lastNonZero = opacity;
    for (const d of dimmables) d.set(opacity);
    group.visible = opacity > 0.001; // skip the draw entirely when black
    if (persist) { try { localStorage.setItem(STORAGE_KEY, String(opacity)); } catch { /* ignore */ } }
  }
  apply(opacity, false);

  const animate = (t: number): void => {
    if (!group.visible) return;
    starField.rotation.y = t * 0.005; // very slow drift
    auroraTex.offset.x = t * 0.01; // curtains drift sideways
    auroraMat.opacity = AURORA_BASE * opacity * (0.75 + 0.25 * Math.sin(t * 0.5)); // slow breathing
  };

  return {
    group,
    animate,
    setOpacity: (x) => apply(x),
    setVisible: (on) => apply(on ? lastNonZero : 0),
    current: () => opacity,
  };
}
