import * as THREE from "three";
import { BUILDINGS, DOORS, LOT_BOUNDS, PLAZA, type BuildingKind } from "../core/lobby-layout";
import type { PresenceEmote } from "../core/presence";
import { buildBuilding } from "./buildings";
import { buildLobbyBackdrop, type LobbyBackdrop } from "./lobby-backdrop";
import { createRemoteCars, type RemoteCarResolver } from "./remote-cars";

export interface RemoteCarState {
  id: string;
  name: string;
  carId: string;
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export interface Lobby {
  group: THREE.Group;
  show(): void;
  hide(): void;
  /** multiplayer seam — called with [] today; later a presence feed drives ghost cars */
  setRemoteCars(states: RemoteCarState[]): void;
  /** pulse a remote driver's visual-only emote */
  emoteRemote(event: PresenceEmote): void;
  /** which entry ring the player's car is inside (flares that ring), or null */
  setActiveDoor(kind: BuildingKind | null): void;
  /** synthwave dusk backdrop — dial/kill-switch exposed for live tuning (see lobby-backdrop.ts) */
  backdrop: LobbyBackdrop;
  update(dt: number): void;
  dispose(): void;
}

function signTexture(name: string, css: string, px = 84): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.font = `700 ${px}px 'Chakra Petch', ui-monospace, monospace`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = css; g.shadowBlur = 28;
  g.fillStyle = css;
  g.fillText(name, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/** `detail` — "full" is the designed look (high tier, untouched); "reduced" (low tier)
 *  halves the drifting neon dust. Buildings, door rings and storefront lights stay — the
 *  town has to read as the town on every tier. */
export function createLobby(
  detail: "full" | "reduced" = "full",
  resolveRemoteCar: RemoteCarResolver = () => null,
): Lobby {
  const group = new THREE.Group();
  group.visible = false;
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // floor
  const floorGeo = track(new THREE.PlaneGeometry(LOT_BOUNDS.x * 2, LOT_BOUNDS.z * 2));
  const floorMat = track(new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.55, roughness: 0.45 }));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  // soft light pool in the plaza — a radial glow lifting the centre of the lot off the dark floor
  const poolC = document.createElement("canvas"); poolC.width = poolC.height = 256;
  const pgx = poolC.getContext("2d")!;
  const pgrd = pgx.createRadialGradient(128, 128, 0, 128, 128, 128);
  pgrd.addColorStop(0, "rgba(120,170,255,0.30)");
  pgrd.addColorStop(0.45, "rgba(96,64,200,0.10)");
  pgrd.addColorStop(1, "rgba(96,64,200,0)");
  pgx.fillStyle = pgrd; pgx.fillRect(0, 0, 256, 256);
  const poolMat = track(new THREE.MeshBasicMaterial({
    map: track(new THREE.CanvasTexture(poolC)),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  const pool = new THREE.Mesh(track(new THREE.PlaneGeometry(150, 150)), poolMat);
  pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.03, 0); // plaza centre, just above the floor
  pool.renderOrder = -2;
  group.add(pool);

  // neon grid over the floor, but with a radial vertex-colour fade: each line melts from its neon
  // colour (crisp near the plaza) toward the floor colour (invisible at the lot edges), so the grid
  // dissolves into the dark instead of tiling to the horizon like a debug grid.
  const grid = new THREE.GridHelper(Math.max(LOT_BOUNDS.x, LOT_BOUNDS.z) * 2, 60, 0xff4dd2, 0x7a34c9);
  const gm = grid.material as THREE.LineBasicMaterial;
  gm.transparent = true; gm.opacity = 0.6; gm.depthWrite = false;
  const gpos = grid.geometry.attributes.position;
  const gcol = grid.geometry.attributes.color;
  const fr = 0x0a / 255, fgc = 0x08 / 255, fb = 0x20 / 255; // floor colour 0x0a0820 to melt toward
  const FADE0 = 54, FADE1 = 118; // crisp within FADE0, melted into the floor by FADE1 (half-extent 120)
  for (let i = 0; i < gpos.count; i++) {
    const r = Math.hypot(gpos.getX(i), gpos.getZ(i));
    const f = 1 - Math.min(1, Math.max(0, (r - FADE0) / (FADE1 - FADE0)));
    const ff = f * f; // ease so the falloff feels smooth
    gcol.setXYZ(i, fr + (gcol.getX(i) - fr) * ff, fgc + (gcol.getY(i) - fgc) * ff, fb + (gcol.getZ(i) - fb) * ff);
  }
  gcol.needsUpdate = true;
  grid.position.y = 0.02;
  group.add(grid);

  // ---- Town-square roads: a loop ring around the plaza + the open south entrance strip. Cosmetic
  // — the whole floor stays drivable; the road just marks the plaza you circle and the way in.
  // Geometry from PLAZA so the art can't drift from the layout/door positions.
  const roadMat = track(new THREE.MeshStandardMaterial({ color: 0x141026, metalness: 0.2, roughness: 0.85 }));
  const centreMat = track(new THREE.MeshBasicMaterial({
    color: 0x27e7ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const loopInner = PLAZA.loopRadius - PLAZA.loopWidth / 2;
  const loopOuter = PLAZA.loopRadius + PLAZA.loopWidth / 2;
  // loop asphalt (flat ring) + glowing centreline ring
  const loop = new THREE.Mesh(track(new THREE.RingGeometry(loopInner, loopOuter, 72)), roadMat);
  loop.rotation.x = -Math.PI / 2; loop.position.set(PLAZA.center.x, 0.025, PLAZA.center.z);
  group.add(loop);
  const loopLine = new THREE.Mesh(track(new THREE.RingGeometry(PLAZA.loopRadius - 0.4, PLAZA.loopRadius + 0.4, 72)), centreMat);
  loopLine.rotation.x = -Math.PI / 2; loopLine.position.set(PLAZA.center.x, 0.03, PLAZA.center.z);
  group.add(loopLine);
  // south entrance strip — from the spawn approach in through the loop to the plaza
  {
    const e = PLAZA.entrance;
    const dx = e.to.x - e.from.x, dz = e.to.z - e.from.z;
    const len = Math.hypot(dx, dz);
    const g = new THREE.Group();
    g.position.set((e.from.x + e.to.x) / 2, 0, (e.from.z + e.to.z) / 2);
    g.rotation.y = Math.atan2(dx, dz);
    const strip = new THREE.Mesh(track(new THREE.PlaneGeometry(PLAZA.loopWidth, len)), roadMat);
    strip.rotation.x = -Math.PI / 2; strip.position.y = 0.025;
    g.add(strip);
    const cl = new THREE.Mesh(track(new THREE.PlaneGeometry(0.7, len)), centreMat);
    cl.rotation.x = -Math.PI / 2; cl.position.y = 0.03;
    g.add(cl);
    group.add(g);
  }

  // glowing perimeter walls
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0x180a30, emissive: 0xff4dd2, emissiveIntensity: 0.55 }));
  const wallGeoLR = track(new THREE.BoxGeometry(1, 2.4, LOT_BOUNDS.z * 2));
  const wallGeoFB = track(new THREE.BoxGeometry(LOT_BOUNDS.x * 2, 2.4, 1));
  const addWall = (geo: THREE.BoxGeometry, x: number, z: number) => {
    const m = new THREE.Mesh(geo, wallMat); m.position.set(x, 1.2, z); group.add(m);
  };
  addWall(wallGeoLR, -LOT_BOUNDS.x, 0); addWall(wallGeoLR, LOT_BOUNDS.x, 0);
  addWall(wallGeoFB, 0, -LOT_BOUNDS.z); addWall(wallGeoFB, 0, LOT_BOUNDS.z);

  // buildings — each corner gets a themed structure (garage bay / start gate / upgrade tower /
  // container yard). The builder makes it in local space with the entrance on +Z; we position it
  // in its corner and rotate `b.rot` so that +Z faces the plaza, then float the neon sign + a lamp
  // out in front. Any animated greebles register an `animate(t)` we drive from update().
  const animators: Array<(t: number) => void> = [];

  // synthwave-dusk backdrop (sky dome + retro sun + skyline + stars) — its own group, dialable/black-able
  const backdrop = buildLobbyBackdrop(track);
  group.add(backdrop.group);
  animators.push((t) => backdrop.animate(t));

  for (const b of BUILDINGS) {
    const bg = new THREE.Group(); bg.position.set(b.x, 0, b.z); bg.rotation.y = b.rot;
    const hex = "#" + b.color.toString(16).padStart(6, "0");

    const built = buildBuilding(b.kind, b.color, track);
    bg.add(built.group);
    if (built.animate) animators.push(built.animate);

    const signGeo = track(new THREE.PlaneGeometry(b.w * 0.92, b.w * 0.92 / 4));
    const signMat = track(new THREE.MeshBasicMaterial({ map: track(signTexture(b.name, hex)), transparent: true, depthWrite: false }));
    const sign = new THREE.Mesh(signGeo, signMat); sign.position.set(0, built.signY, built.frontZ + 0.1); bg.add(sign);

    // a smaller amber "COMING SOON" placard under the main sign for not-yet-built storefronts
    if (b.comingSoon) {
      const csW = b.w * 0.55;
      const csGeo = track(new THREE.PlaneGeometry(csW, csW / 4));
      const csMat = track(new THREE.MeshBasicMaterial({ map: track(signTexture("COMING SOON", "#ffb020", 60)), transparent: true, depthWrite: false }));
      const cs = new THREE.Mesh(csGeo, csMat);
      cs.position.set(0, built.signY - (b.w * 0.92) / 8 - csW / 8 - 0.4, built.frontZ + 0.1);
      bg.add(cs);
    }

    const lamp = new THREE.PointLight(b.color, 7, 34, 2); lamp.position.set(0, 5, built.frontZ + 3); bg.add(lamp);
    group.add(bg);
  }

  // ---- glowing entry rings: one storefront-wide circle on the ground per doorway ----
  // Each ring = translucent fill disc + bright rim + spinning dashed orbit + an expanding ripple.
  // Idle they breathe softly; the ring the car is inside flares bright and spins faster.
  interface EntryRing {
    kind: BuildingKind;
    fill: THREE.MeshBasicMaterial;
    rim: THREE.MeshBasicMaterial;
    dash: THREE.MeshBasicMaterial;
    rippleMat: THREE.MeshBasicMaterial;
    ripple: THREE.Mesh;
    spin: THREE.Group;
    phase: number;
  }
  const rings: EntryRing[] = [];
  const ringMat = (color: number, opacity: number) =>
    track(new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  for (let i = 0; i < DOORS.length; i++) {
    const d = DOORS[i];
    const color = BUILDINGS.find((b) => b.kind === d.kind)!.color;
    const rg = new THREE.Group();
    rg.position.set(d.x, 0.05, d.z);
    rg.rotation.x = -Math.PI / 2; // lay flat; local +Z is now world up
    group.add(rg);

    const fill = ringMat(color, 0.05);
    rg.add(new THREE.Mesh(track(new THREE.CircleGeometry(d.r, 48)), fill));

    const rim = ringMat(color, 0.5);
    rg.add(new THREE.Mesh(track(new THREE.RingGeometry(d.r * 0.94, d.r, 64)), rim));

    // dashed orbit: 8 short arcs sharing one material, spun as a group
    const dash = ringMat(color, 0.55);
    const spin = new THREE.Group();
    const arcGeo = track(new THREE.RingGeometry(d.r * 0.8, d.r * 0.87, 10, 1, 0, Math.PI / 7));
    for (let a = 0; a < 8; a++) {
      const m = new THREE.Mesh(arcGeo, dash);
      m.rotation.z = (a * Math.PI) / 4;
      spin.add(m);
    }
    rg.add(spin);

    const rippleMat = ringMat(color, 0);
    const ripple = new THREE.Mesh(track(new THREE.RingGeometry(d.r * 0.9, d.r, 64)), rippleMat);
    rg.add(ripple);

    rings.push({ kind: d.kind, fill, rim, dash, rippleMat, ripple, spin, phase: i * 1.7 });
  }
  let activeDoor: BuildingKind | null = null;

  // ---- drifting neon dust over the plaza — slow ambient motion so the lot feels alive ----
  const DUST_N = detail === "reduced" ? 45 : 90;
  const dustPos = new Float32Array(DUST_N * 3);
  const dustCol = new Float32Array(DUST_N * 3);
  const palette = [new THREE.Color(0xff4dd2), new THREE.Color(0x27e7ff), new THREE.Color(0x6a2bd9)];
  for (let i = 0; i < DUST_N; i++) {
    dustPos[i * 3] = (Math.random() * 2 - 1) * 105;
    dustPos[i * 3 + 1] = 1.5 + Math.random() * 17;
    dustPos[i * 3 + 2] = -95 + Math.random() * 165;
    const c = palette[i % palette.length];
    dustCol[i * 3] = c.r; dustCol[i * 3 + 1] = c.g; dustCol[i * 3 + 2] = c.b;
  }
  const dustGeo = track(new THREE.BufferGeometry());
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute("color", new THREE.BufferAttribute(dustCol, 3));
  const dustMat = track(new THREE.PointsMaterial({
    size: 0.45, vertexColors: true, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const dust = new THREE.Points(dustGeo, dustMat);
  group.add(dust);

  // ambient fill so the lot isn't pitch black
  const amb = new THREE.AmbientLight(0x6a4cff, 0.5); group.add(amb);

  // Remote drivers are presentation-only. They are not part of lobby layout or collision state.
  const remoteCars = createRemoteCars(resolveRemoteCar);
  group.add(remoteCars.group);

  let t = 0;
  return {
    group,
    backdrop,
    show() { group.visible = true; },
    hide() { group.visible = false; },
    setRemoteCars(states) { remoteCars.setTargets(states); },
    emoteRemote(event) { remoteCars.emote(event); },
    setActiveDoor(kind) { activeDoor = kind; },
    update(dt) {
      t += dt;
      for (const a of animators) a(t);
      for (const r of rings) {
        const on = r.kind === activeDoor;
        r.fill.opacity = on ? 0.15 + 0.05 * Math.sin(t * 6) : 0.05;
        r.rim.opacity = on ? 0.95 : 0.42 + 0.16 * Math.sin(t * 2 + r.phase);
        r.dash.opacity = on ? 0.9 : 0.5;
        r.spin.rotation.z = t * (on ? 1.8 : 0.35) + r.phase;
        // ripple: a ring that repeatedly expands from the centre and fades out at the rim
        const ph = ((t * (on ? 1.4 : 0.5) + r.phase) % 1.4) / 1.4;
        r.ripple.scale.setScalar(0.2 + 0.8 * ph);
        r.rippleMat.opacity = (1 - ph) * (on ? 0.7 : 0.28);
      }
      dust.rotation.y = t * 0.02;
      dust.position.y = 0.4 * Math.sin(t * 0.35);
      remoteCars.update(dt);
    },
    dispose() {
      remoteCars.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
