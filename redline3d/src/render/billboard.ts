import * as THREE from "three";

/**
 * The strip's jumbotron — a tall neon board over the building arc cycling recent action.
 * Social proof for the meet: names bank multipliers, someone wrecks, the house record
 * taunts. Feed is locally simulated today; `noteSettle()` is the seam a real settle
 * stream (own rounds now, everyone's rounds once presence lands) pushes into.
 */

export interface BoardEntry {
  tag: string;
  /** settle multiplier (0 = wrecked) */
  mult: number;
  /** SOL banked — omitted for wrecks */
  sol?: number;
}

export interface StripBillboard {
  group: THREE.Group;
  update(dt: number): void;
  /** push a real settle onto the board (shown on the next cycle, newest first) */
  noteSettle(e: BoardEntry): void;
  dispose(): void;
}

/** one board line, player-speak — exported for tests */
export function fmtEntry(e: BoardEntry): string {
  if (e.mult <= 0) return `${e.tag} wrecked ×0.00`;
  const sol = e.sol !== undefined ? ` · +${e.sol.toFixed(2)} SOL` : "";
  return `${e.tag} banked ×${e.mult.toFixed(2)}${sol}`;
}

/** demo action while the board has no real settles — names match the parked cars */
export const DEMO_FEED: BoardEntry[] = [
  { tag: "liq_dodger", mult: 14.2, sol: 0.71 },
  { tag: "moonbag_mia", mult: 2.4, sol: 0.12 },
  { tag: "haulin_hal", mult: 0 },
  { tag: "triple7s_tony", mult: 7.77, sol: 0.39 },
  { tag: "honkmaster", mult: 1.9, sol: 0.1 },
  { tag: "liq_dodger", mult: 0 },
  { tag: "moonbag_mia", mult: 31.0, sol: 1.55 },
];

const CYCLE_S = 4;        // seconds per entry
const W = 42, H = 14;     // board face in world units (canvas is ~3:1)
const POLE_H = 15;        // screen bottom sits this high — clears every storefront roofline

export function createStripBillboard(): StripBillboard {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // canvas screen
  const canvas = document.createElement("canvas");
  canvas.width = 1024; canvas.height = 340;
  const g = canvas.getContext("2d")!;
  const tex = track(new THREE.CanvasTexture(canvas));
  tex.anisotropy = 4;

  const feed: BoardEntry[] = [];  // real settles, newest first (capped)
  let idx = 0;
  let cd = 0; // seconds until the next entry cycles in

  const draw = (line: string, color: string) => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    // panel
    g.fillStyle = "rgba(7,5,22,0.96)";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = "#27e7ff";
    g.lineWidth = 6;
    g.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
    // header
    g.font = "700 44px 'Chakra Petch', ui-monospace, monospace";
    g.textAlign = "left"; g.textBaseline = "middle";
    g.fillStyle = "#8f9bd6";
    g.fillText("THE STRIP · LIVE", 36, 64);
    g.textAlign = "right";
    g.fillStyle = "#ffd166";
    g.fillText("record ×2000", canvas.width - 36, 64);
    g.strokeStyle = "rgba(143,155,214,0.35)";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(30, 104); g.lineTo(canvas.width - 30, 104); g.stroke();
    // the action line
    g.font = "700 64px 'Chakra Petch', ui-monospace, monospace";
    g.textAlign = "center";
    g.shadowColor = color; g.shadowBlur = 22;
    g.fillStyle = color;
    g.fillText(line, canvas.width / 2, 222, canvas.width - 72);
    g.shadowBlur = 0;
    tex.needsUpdate = true;
  };

  const cycle = () => {
    const src = feed.length ? feed : DEMO_FEED;
    const e = src[idx % src.length];
    idx++;
    draw(fmtEntry(e), e.mult <= 0 ? "#ff4d6d" : "#2ee6a6");
  };

  // structure: two poles + the screen, high over the arc so it reads over the storefronts
  const poleMat = track(new THREE.MeshStandardMaterial({ color: 0x181233, emissive: 0x6a2bd9, emissiveIntensity: 0.35 }));
  const poleGeo = track(new THREE.BoxGeometry(0.9, POLE_H + H, 0.9));
  for (const px of [-W / 2 + 1.4, W / 2 - 1.4]) {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(px, (POLE_H + H) / 2, 0);
    group.add(pole);
  }
  const screen = new THREE.Mesh(
    track(new THREE.PlaneGeometry(W, H)),
    track(new THREE.MeshBasicMaterial({ map: tex, transparent: false })),
  );
  screen.position.set(0, POLE_H + H / 2, 0.5);
  group.add(screen);
  // additive halo behind the screen so it glows against the night sky
  const halo = new THREE.Mesh(
    track(new THREE.PlaneGeometry(W + 3, H + 3)),
    track(new THREE.MeshBasicMaterial({
      color: 0x27e7ff, transparent: true, opacity: 0.10,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    })),
  );
  halo.position.set(0, POLE_H + H / 2, 0.2);
  group.add(halo);

  cycle(); // first paint (don't wait a cycle to show something)

  return {
    group,
    update(dt) {
      cd -= dt;
      if (cd <= 0) { cd = CYCLE_S; cycle(); }
    },
    noteSettle(e) {
      feed.unshift(e);
      if (feed.length > 12) feed.pop();
      idx = 0;         // restart at the newest
      cd = 0;          // show it on the very next update tick
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
