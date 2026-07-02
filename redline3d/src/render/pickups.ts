import * as THREE from "three";

/** result of a frame's collection: physical coins caught, total coin VALUE (with
 * Vaporwave multipliers), and the >1 multipliers caught (for the floating ×N pops) */
export interface CoinHit { count: number; value: number; pops: number[]; }

export interface Pickups {
  group: THREE.Group;
  /** advance pickups; collect=false (idle/showroom) → coins drift by but can't be caught */
  update(dt: number, speed: number, carX: number, surfaceY: (z: number) => number, collect?: boolean): CoinHit;
  /** Vaporwave ability: coins turn rainbow and roll a hidden value multiplier on pickup */
  setRainbow(on: boolean): void;
  /** Cart Rod ability: coins recycle over a shorter span → `rate`× more coins on the road (1 = stock) */
  setCoinRate(rate: number): void;
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
const GOLD_C = "#3a2a00", GOLD_E = "#ffd166";

export function createPickups(): Pickups {
  const group = new THREE.Group();
  const geo = new THREE.OctahedronGeometry(0.95);
  const coins: THREE.Mesh[] = [];
  const matOf = (m: THREE.Mesh) => m.material as THREE.MeshStandardMaterial;

  const place = (m: THREE.Mesh, z: number) => {
    m.position.set(LANES[(Math.random() * LANES.length) | 0], 1.7, z);
    m.visible = true;
  };
  for (let i = 0; i < N; i++) {
    // per-coin material so rainbow mode can hue each coin independently
    const mat = new THREE.MeshStandardMaterial({ color: GOLD_C, emissive: GOLD_E, emissiveIntensity: 1.5, metalness: 0.6, roughness: 0.3 });
    const m = new THREE.Mesh(geo, mat);
    place(m, RECYCLE - 240 - i * SP);
    group.add(m);
    coins.push(m);
  }

  let rainbow = false;
  let rate = 1;
  let time = 0;

  return {
    group,
    setRainbow(on) {
      rainbow = on;
      if (!on) for (const m of coins) { matOf(m).color.set(GOLD_C); matOf(m).emissive.set(GOLD_E); }
    },
    setCoinRate(r) {
      rate = r; // takes hold as coins recycle — the road re-spaces itself within a wrap
    },
    update(dt, speed, carX, surfaceY, collect = true) {
      time += dt;
      let count = 0, value = 0;
      const pops: number[] = [];
      coins.forEach((m, i) => {
        m.position.z += speed * dt;
        m.position.y = 1.8 + surfaceY(m.position.z);
        m.rotation.y += dt * 3.2;
        if (rainbow) {
          const hue = (time * 0.12 + i * 0.137) % 1; // flowing per-coin rainbow
          matOf(m).emissive.setHSL(hue, 1, 0.6);
          matOf(m).color.setHSL(hue, 0.8, 0.18);
        }
        if (collect && m.visible && m.position.z > CATCH_Z0 && m.position.z < CATCH_Z1 && Math.abs(m.position.x - carX) < CATCH_X) {
          m.visible = false;
          count++;
          const mult = rainbow ? coinMult(Math.random()) : 1;
          value += mult;
          if (mult > 1) pops.push(mult);
        }
        if (m.position.z > RECYCLE) place(m, m.position.z - recycleSpan(rate));
      });
      return { count, value, pops };
    },
  };
}
