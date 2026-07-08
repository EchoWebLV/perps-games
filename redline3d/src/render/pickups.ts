import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** result of a frame's collection: physical coins caught, total coin VALUE (with Vaporwave
 * multipliers), the >1 multipliers caught (for the floating ×N pops), and SCRAP POINTS caught
 * — every 3rd–5th pickup comes up as a scrap heap worth its grade's points (1/3/5).
 * update() REUSES one instance across calls (hot rAF path — no per-frame garbage): read the
 * fields immediately, never store the object across frames. */
export interface CoinHit { count: number; value: number; pops: number[]; scrap: number; }

export interface Pickups {
  group: THREE.Group;
  /** advance pickups; collect=false (idle/showroom) → coins drift by but can't be caught */
  update(dt: number, speed: number, carX: number, surfaceY: (z: number) => number, collect?: boolean): CoinHit;
  /** Vaporwave ability: coins turn rainbow and roll a hidden value multiplier on pickup */
  setRainbow(on: boolean): void;
  /** Cart Rod ability: coins recycle over a shorter span → `rate`× more coins on the road (1 = stock) */
  setCoinRate(rate: number): void;
  /** Magnet ability: approaching coins curve into the car's lane so none escape — collect them all */
  setMagnet(on: boolean): void;
}

/** Cart Rod "Coin Scoop": a third more coins on the road (+33%) */
export const CART_COIN_RATE = 4 / 3;

/** roll a coin's value multiplier from a uniform r∈[0,1): 3% ×5, 6% ×3, 12% ×2, else ×1 */
export function coinMult(r: number): 1 | 2 | 3 | 5 {
  if (r < 0.03) return 5;   // 3%
  if (r < 0.09) return 3;   // 0.03–0.09 → 6%
  if (r < 0.21) return 2;   // 0.09–0.21 → 12%
  return 1;                 // 79%
}

const LANES = [-8, -4, 0, 4, 8];
const N = 9;
const SP = 110;          // spacing along z
const TOTAL = N * SP;
/** wrap-around span for a recycled coin: the same N coins spread over TOTAL/rate road,
 * so coin density (coins passed per unit driven) scales by exactly `rate` */
export const recycleSpan = (rate: number) => TOTAL / rate;
const RECYCLE = 22;      // z past the camera → wrap to the far end
const CATCH_Z0 = -14, CATCH_Z1 = -9;  // z window around the car where a coin can be caught
const CATCH_X = 3.2;     // lateral catch radius
// Magnet "Coin Magnet": coins bend toward the car's lane over their whole approach so
// they funnel into the catch window — the car vacuums up every coin regardless of lane.
const MAG_REACH = -80;   // z ahead of the car where the magnetic pull kicks in
const MAG_PULL = 7;      // ease strength (1/s) dragging a coin's x toward the car's lane
const MAG_CATCH_X = 6.5; // widened lateral catch while magnetized (backstop for a fast coin)
const GOLD_C = "#3a2a00", GOLD_E = "#ffd166";

// Scrap grades — a scrap pickup replaces a coin every 3rd–5th spawn. Each grade is a jumbled
// HEAP of junk metal (built by scrapHeapGeo below), not a gold gem, and is worth different
// scrap points: bigger, shinier heap = more points. Weights sum to 100. The point spread IS
// the idea of "different scraps give different points."
export interface ScrapGrade {
  key: string; name: string; pts: number; weight: number;
  color: number; emissive: number; glow: number; rough: number; scale: number; bits: number; radius: number;
}
// Every grade is a BIG, GLOWING hot-metal pile — a bright-orange emissive that clears the bloom
// threshold (dim rust vanished at speed) + a glow HALO behind it, so it's impossible to miss on
// the dark road. Value shows as pile SIZE; all glow, hunk brightest. `scale` is ~3× the coin.
export const SCRAP_GRADES: readonly ScrapGrade[] = [
  { key: "shard", name: "Scrap Shard", pts: 1, weight: 60, color: 0x3a2213, emissive: 0xff7a1e, glow: 1.7, rough: 0.48, scale: 2.8, bits: 6,  radius: 0.34 },
  { key: "chunk", name: "Scrap Chunk", pts: 3, weight: 30, color: 0x40260f, emissive: 0xff8a24, glow: 1.9, rough: 0.44, scale: 3.0, bits: 10, radius: 0.50 },
  { key: "hunk",  name: "Scrap Hunk",  pts: 5, weight: 10, color: 0x4a2a10, emissive: 0xffb34a, glow: 2.2, rough: 0.40, scale: 3.2, bits: 15, radius: 0.62 },
];
const SCRAP_WEIGHT = SCRAP_GRADES.reduce((s, g) => s + g.weight, 0);

/** pick a scrap grade index from r∈[0,1) by weight (60/30/10 → shard/chunk/hunk) */
export function scrapGradeIdx(r: number): number {
  let x = r * SCRAP_WEIGHT;
  for (let i = 0; i < SCRAP_GRADES.length; i++) { if ((x -= SCRAP_GRADES[i].weight) < 0) return i; }
  return SCRAP_GRADES.length - 1;
}

/** a toothed cog — a flat disc ringed with little box teeth (the hero shape of any scrap pile). */
function scrapGear(r: number, teeth: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(r, r, 0.11, 16)];
  for (let t = 0; t < teeth; t++) {
    const a = (t / teeth) * Math.PI * 2;
    const tooth = new THREE.BoxGeometry(0.1, 0.11, 0.11);
    tooth.applyMatrix4(new THREE.Matrix4().makeRotationY(-a).setPosition(Math.cos(a) * r, 0, Math.sin(a) * r));
    parts.push(tooth);
  }
  const gear = mergeGeometries(parts, false) as THREE.BufferGeometry;
  parts.forEach((p) => p.dispose());
  return gear;
}

/** one recognizable junk part — a bolt/rod, hex nut, washer/coil, cog, or a bent plate. */
function scrapPart(): THREE.BufferGeometry {
  const k = Math.random();
  if (k < 0.24) { const r = 0.07 + Math.random() * 0.05; return new THREE.CylinderGeometry(r, r, 0.55 + Math.random() * 0.6, 8); }  // bolt / rod / pipe
  if (k < 0.44) { const r = 0.17 + Math.random() * 0.1;  return new THREE.CylinderGeometry(r, r, 0.12 + Math.random() * 0.08, 6); } // hex nut
  if (k < 0.64) return new THREE.TorusGeometry(0.15 + Math.random() * 0.1, 0.045 + Math.random() * 0.03, 6, 12);                     // washer / ring / coil
  if (k < 0.83) return scrapGear(0.2 + Math.random() * 0.12, 8 + ((Math.random() * 4) | 0));                                         // cog / gear
  return new THREE.BoxGeometry(0.35 + Math.random() * 0.35, 0.07, 0.28 + Math.random() * 0.3);                                       // bent plate
}

/** a MOUND of junk parts merged into one geometry — reads as a pile of scrap, not a gem.
 *  `bits` = how many parts; `radius` = how wide it spreads (the center rides higher → a pile). */
function scrapHeapGeo(bits: number, radius: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < bits; i++) {
    const g = scrapPart();
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * radius;      // uniform over the disc
    const y = 0.30 - rr * 0.62 + Math.random() * 0.12; // center rides high, edges sink → a mound
    g.applyMatrix4(new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI))
      .setPosition(Math.cos(ang) * rr, y, Math.sin(ang) * rr));
    parts.push(g);
  }
  const heap = mergeGeometries(parts, false) as THREE.BufferGeometry;
  parts.forEach((p) => p.dispose());
  heap.computeVertexNormals();
  return heap;
}

/** a soft white radial glow (procedural DataTexture — no canvas, safe in tests) for the attention
 *  HALO behind each scrap pile, so it pops on the dark road even before bloom. */
function glowTexture(): THREE.DataTexture {
  const S = 64, data = new Uint8Array(S * S * 4), c = (S - 1) / 2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - c) / c, dy = (y - c) / c;
    const a = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
    const i = (y * S + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(a * a * 255);
  }
  const tex = new THREE.DataTexture(data, S, S);
  tex.needsUpdate = true;
  return tex;
}

export function createPickups(): Pickups {
  const group = new THREE.Group();
  const coinGeo = new THREE.OctahedronGeometry(0.95);
  const heapGeos = SCRAP_GRADES.map((g) => scrapHeapGeo(g.bits, g.radius)); // one shared pile mesh per grade
  const glowTex = glowTexture(); // shared attention-halo texture
  const coins: THREE.Mesh[] = [];
  const matOf = (m: THREE.Mesh) => m.material as THREE.MeshStandardMaterial;

  // Dress a pickup as a gold coin (octahedron gem) or as a scrap heap of the given grade — a mesh
  // swaps its geometry + scale + material look, and carries its grade on userData so the catch
  // banks the right points and rainbow-restore can repaint it.
  const asCoin = (m: THREE.Mesh) => {
    m.userData.scrap = false; m.userData.scrapPts = 0;
    m.geometry = coinGeo; m.scale.setScalar(1);
    (m.userData.halo as THREE.Sprite).visible = false; // coins already pop (bright gold + bloom)
    const mat = matOf(m);
    mat.color.set(GOLD_C); mat.emissive.set(GOLD_E); mat.emissiveIntensity = 1.5; mat.metalness = 0.6; mat.roughness = 0.3;
  };
  const asScrap = (m: THREE.Mesh, gi: number) => {
    const g = SCRAP_GRADES[gi];
    m.userData.scrap = true; m.userData.scrapPts = g.pts; m.userData.scrapGi = gi;
    m.geometry = heapGeos[gi]; m.scale.setScalar(g.scale);
    const mat = matOf(m);
    mat.color.setHex(g.color); mat.emissive.setHex(g.emissive); mat.emissiveIntensity = g.glow; mat.metalness = 0.65; mat.roughness = g.rough;
    const halo = m.userData.halo as THREE.Sprite;       // glow aura behind the pile → unmissable
    halo.visible = true;
    (halo.material as THREE.SpriteMaterial).color.setHex(g.emissive);
    halo.scale.setScalar(1.9); // child of the pile → world size = pile scale × this
  };

  // Every 3rd–5th pickup laid on the road comes up scrap (grade rolled by weight) instead of a coin.
  const randGap = () => 3 + ((Math.random() * 3) | 0); // 3, 4, or 5
  let toNextScrap = randGap();
  const place = (m: THREE.Mesh, z: number) => {
    m.position.set(LANES[(Math.random() * LANES.length) | 0], 1.7, z);
    m.visible = true;
    if (--toNextScrap <= 0) { toNextScrap = randGap(); asScrap(m, scrapGradeIdx(Math.random())); }
    else asCoin(m);
  };
  for (let i = 0; i < N; i++) {
    // per-pickup material so rainbow mode can hue each coin independently
    const mat = new THREE.MeshStandardMaterial({ color: GOLD_C, emissive: GOLD_E, emissiveIntensity: 1.5, metalness: 0.6, roughness: 0.3 });
    const m = new THREE.Mesh(coinGeo, mat);
    // attention halo (a child so it rides the pickup) — soft additive glow, shown only for scrap
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff8a24, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    halo.visible = false;
    m.add(halo);
    m.userData.halo = halo;
    place(m, RECYCLE - 240 - i * SP);
    group.add(m);
    coins.push(m);
  }

  let rainbow = false;
  let rate = 1;
  let magnet = false;
  let time = 0;
  const hit: CoinHit = { count: 0, value: 0, pops: [], scrap: 0 }; // reused every update — see the CoinHit note

  return {
    group,
    setRainbow(on) {
      rainbow = on;
      if (!on) for (const m of coins) m.userData.scrap ? asScrap(m, m.userData.scrapGi) : asCoin(m); // repaint
    },
    setCoinRate(r) {
      rate = r; // takes hold as coins recycle — the road re-spaces itself within a wrap
    },
    setMagnet(on) {
      magnet = on; // pull kicks in immediately for coins already inside MAG_REACH
    },
    update(dt, speed, carX, surfaceY, collect = true) {
      time += dt;
      hit.count = 0; hit.value = 0; hit.scrap = 0; hit.pops.length = 0;
      for (let i = 0; i < coins.length; i++) {
        const m = coins[i];
        m.position.z += speed * dt;
        m.position.y = 1.8 + surfaceY(m.position.z);
        m.rotation.y += dt * 3.2;
        if (rainbow && !m.userData.scrap) { // scrap stays steel; only coins go rainbow
          const hue = (time * 0.12 + i * 0.137) % 1; // flowing per-coin rainbow
          matOf(m).emissive.setHSL(hue, 1, 0.6);
          matOf(m).color.setHSL(hue, 0.8, 0.18);
        }
        // Magnet: bend an approaching coin into the car's lane so it can't slip past
        if (magnet && collect && m.visible && m.position.z > MAG_REACH && m.position.z < CATCH_Z1) {
          m.position.x += (carX - m.position.x) * (1 - Math.exp(-MAG_PULL * dt));
        }
        const catchX = magnet ? MAG_CATCH_X : CATCH_X;
        if (collect && m.visible && m.position.z > CATCH_Z0 && m.position.z < CATCH_Z1 && Math.abs(m.position.x - carX) < catchX) {
          m.visible = false;
          if (m.userData.scrap) {
            hit.scrap += m.userData.scrapPts; // grade points (1/3/5) → banked to the garage save for the Scrap Yard
          } else {
            hit.count++;
            const mult = rainbow ? coinMult(Math.random()) : 1;
            hit.value += mult;
            if (mult > 1) hit.pops.push(mult);
          }
        }
        if (m.position.z > RECYCLE) place(m, m.position.z - recycleSpan(rate));
      }
      return hit;
    },
  };
}
