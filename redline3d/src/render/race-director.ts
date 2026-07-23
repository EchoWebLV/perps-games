// Camera director v2 for the spectator-race preview (DEV-ONLY, used by src/race-preview.ts).
// Broadcast-style automated camera with a CALM cadence: long held shots (9–14s), a hard minimum
// cooldown between any cuts, gentle eased moves, soft FOV kicks and light handheld shake. In AUTO
// it cuts between a low chase, an apex trackside pan and a slow drone arc, and only interrupts for
// an overtake battle when it actually matters (a change of the lead, or the bettor's own car, or
// nothing has happened in a while) — mid-pack scraps are ignored. It swings to a head-on
// finish-line hold for the last stretch and a hero orbit at the flag. Manual modes (CHASE / TV /
// DRONE) lock the shot onto a chosen focus car. Every frame it also pushes the camera out of any
// car it would clip into.
import * as THREE from "three";
import type { RaceTrack } from "./race-track";

export interface DirectorCar {
  dist: number;
  laneOff: number;
  pos: THREE.Vector3;
  speed: number;
  surges: Array<{ start: number; len: number }>;
  finished: boolean;
}

export type DirectorPhase = "LOADING" | "MARKET" | "COUNTDOWN" | "RACING" | "FINISH";
export type DirectorMode = "AUTO" | "CHASE" | "TV" | "DRONE";

export interface DirectorCtx {
  phase: DirectorPhase;
  cars: DirectorCar[];
  order: number[];   // car indices, order[0] = leader
  raceDist: number;
  maxSpeed: number;  // reference top speed for the FOV kick
  mode: DirectorMode; // AUTO = full director; others lock the shot onto `focus`
  focus: number;      // focus car index for manual modes / FOCUS button
  myBet: number;      // the user's bet car index, or -1 (used to gate battle cuts)
}

export interface RaceDirector {
  reset(): void;
  aim(dt: number, ctx: DirectorCtx): void;
}

type Shot = "chase" | "apexPan" | "drone" | "battle" | "finishLine" | "establish" | "hero";
const CYCLE: Shot[] = ["chase", "apexPan", "drone"];
const COOLDOWN = 6;   // minimum seconds between ANY cuts
const CLEAR = 8;      // keep the camera at least this far from every car centre

export function createRaceDirector(camera: THREE.PerspectiveCamera, track: RaceTrack): RaceDirector {
  const camPos = new THREE.Vector3().copy(camera.position);
  const look = new THREE.Vector3(track.center.x, 2, track.center.z);
  const dampLook = new THREE.Vector3().copy(look);
  let fovTarget = camera.fov;

  let shot: Shot = "establish";
  let shotTime = 0;
  let shotDur = 11;
  let sinceCut = 99;
  let cycleIdx = 0;
  let cornerS = track.corners.length ? track.corners[0] : track.tightestTurnS;
  let battle: { att: number; def: number } | null = null;
  let heroTime = 0;

  const P = new THREE.Vector3(), FWD = new THREE.Vector3(), SIDE = new THREE.Vector3();

  const poseF = (dist: number, lane: number) => {
    const p = track.poseAt(dist, lane);
    P.set(p.x, 0, p.z);
    FWD.set(p.tx, 0, p.tz);
    SIDE.set(-p.tz, 0, p.tx);
    return p;
  };
  const centroid = (ctx: DirectorCtx, out: THREE.Vector3) => {
    out.set(0, 0, 0);
    for (const c of ctx.cars) out.add(c.pos);
    return out.multiplyScalar(1 / ctx.cars.length);
  };
  const nearestCornerAhead = (leadDist: number): number => {
    if (!track.corners.length) return track.tightestTurnS;
    let bestS = track.corners[0], best = Infinity;
    for (const cs of track.corners) { let g = cs - (leadDist % track.length); if (g < 0) g += track.length; if (g < best) { best = g; bestS = cs; } }
    return bestS;
  };
  // an overtake worth cutting to: a surging car paired with the car it is passing, but only when
  // the duel involves the current lead, is the bettor's car, or nothing has happened in a while.
  const worthyBattle = (ctx: DirectorCtx): { att: number; def: number } | null => {
    const leader = ctx.order[0];
    for (let i = 0; i < ctx.cars.length; i++) {
      const c = ctx.cars[i];
      if (c.finished) continue;
      let surging = false;
      for (const s of c.surges) if (c.dist > s.start && c.dist < s.start + s.len) { surging = true; break; }
      if (!surging) continue;
      let def = -1, best = Infinity;
      for (let j = 0; j < ctx.cars.length; j++) { if (j === i) continue; const g = ctx.cars[j].dist - c.dist; if (g > 0 && g < best) { best = g; def = j; } }
      if (def === -1) continue;
      const involvesLead = i === leader || def === leader;
      const isMine = i === ctx.myBet || def === ctx.myBet;
      if (involvesLead || isMine || sinceCut > 11) return { att: i, def };
    }
    return null;
  };
  const shake = (t: number, amp: number, out: THREE.Vector3) => {
    out.set(Math.sin(t * 12.1) * 0.6 + Math.sin(t * 6.7) * 0.4, Math.sin(t * 10.3) * 0.5, Math.cos(t * 8.9) * 0.6).multiplyScalar(amp);
  };
  const _sh = new THREE.Vector3();

  const cut = (to: Shot) => { shot = to; shotTime = 0; sinceCut = 0; };

  return {
    reset() { shot = "establish"; shotTime = 0; sinceCut = 99; heroTime = 0; battle = null; cycleIdx = 0; },
    aim(dt, ctx) {
      shotTime += dt; sinceCut += dt;
      const lead = ctx.cars[ctx.order[0]];
      const leadFrac = lead.dist / ctx.raceDist;
      const racing = ctx.phase === "RACING";
      const focusCar = ctx.cars[Math.max(0, Math.min(ctx.cars.length - 1, ctx.focus))] || lead;

      // ---- decide the shot ----
      if (ctx.phase === "LOADING" || ctx.phase === "MARKET" || ctx.phase === "COUNTDOWN") { if (shot !== "establish") cut("establish"); }
      else if (ctx.phase === "FINISH") { if (shot !== "hero") { cut("hero"); heroTime = 0; } }
      else if (ctx.mode === "CHASE") { if (shot !== "chase") cut("chase"); }
      else if (ctx.mode === "DRONE") { if (shot !== "drone") cut("drone"); }
      else if (ctx.mode === "TV") { if (shot !== "apexPan") { cut("apexPan"); cornerS = nearestCornerAhead(focusCar.dist); } }
      else if (racing) { // AUTO
        if (leadFrac > 0.82) { if (shot !== "finishLine") cut("finishLine"); }
        else {
          const b = sinceCut >= COOLDOWN ? worthyBattle(ctx) : null;
          if (b && shot !== "battle") { battle = b; cut("battle"); }
          else if (shot !== "chase" && shot !== "apexPan" && shot !== "drone" && shot !== "battle") { cut("chase"); }
          else if ((shot === "battle" || shotTime > shotDur) && sinceCut >= COOLDOWN) {
            cycleIdx = (cycleIdx + 1) % CYCLE.length;
            cut(CYCLE[cycleIdx]);
            shotDur = 9 + Math.random() * 5; // 9–14s holds
            if (shot === "apexPan") cornerS = nearestCornerAhead(lead.dist);
          }
        }
      }

      // ---- compute camera + look + FOV for the active shot ----
      const cam = new THREE.Vector3(); const tgt = new THREE.Vector3(); let fov = 55;
      const subj = (ctx.mode === "CHASE" || ctx.mode === "TV") ? focusCar : lead;

      if (shot === "chase") {
        poseF(subj.dist, subj.laneOff);
        const speedFrac = Math.min(1, subj.speed / (ctx.maxSpeed || 1));
        fov = 54 + speedFrac * 8; // gentle FOV kick (54→62)
        cam.copy(subj.pos).addScaledVector(FWD, -30).addScaledVector(SIDE, 5).setY(10);
        tgt.copy(subj.pos).addScaledVector(FWD, 12).setY(2.4);
      } else if (shot === "apexPan") {
        poseF(cornerS, 0);
        const ox = P.x - track.center.x, oz = P.z - track.center.z; const ol = Math.hypot(ox, oz) || 1;
        cam.copy(P).addScaledVector(new THREE.Vector3(ox / ol, 0, oz / ol), 40).setY(9);
        shake(shotTime, 0.22, _sh); cam.add(_sh);
        tgt.copy(subj.pos).setY(2.2);
      } else if (shot === "drone") {
        const c = centroid(ctx, tgt);
        const a = shotTime * 0.1 + cycleIdx;
        cam.set(c.x + Math.cos(a) * 90, 64, c.z + Math.sin(a) * 90);
        tgt.setY(2.5);
      } else if (shot === "battle" && battle) {
        const a = ctx.cars[battle.att], d = ctx.cars[battle.def];
        poseF(a.dist, a.laneOff);
        const mid = new THREE.Vector3().addVectors(a.pos, d.pos).multiplyScalar(0.5);
        cam.copy(a.pos).addScaledVector(FWD, -16).addScaledVector(SIDE, 11).setY(5);
        shake(shotTime, 0.2, _sh); cam.add(_sh);
        tgt.copy(mid).addScaledVector(FWD, 5).setY(2.2);
        fov = 48;
      } else if (shot === "finishLine") {
        const s = track.startPose;
        cam.set(s.x + s.tx * 46, 6, s.z + s.tz * 46);
        tgt.copy(lead.pos).setY(2.2);
        fov = 42;
      } else if (shot === "hero") {
        heroTime += dt;
        const w = ctx.cars[ctx.order[0]]; const a = heroTime * 0.4;
        cam.set(w.pos.x + Math.cos(a) * 28, 14, w.pos.z + Math.sin(a) * 28);
        tgt.copy(w.pos).setY(2.6);
      } else { // establish
        const a = shotTime * 0.08;
        const r = track.radius + 150;
        cam.set(track.center.x + Math.cos(a) * r, track.radius * 0.85 + 60, track.center.z + Math.sin(a) * r);
        tgt.set(track.center.x, 4, track.center.z);
      }

      camPos.copy(cam); look.copy(tgt); fovTarget = fov;

      // ---- gentle eased move (~0.6s), then clip-out of any car, then aim ----
      const k = 1 - Math.exp(-2.6 * dt);
      camera.position.lerp(camPos, k);
      dampLook.lerp(look, k);
      for (const c of ctx.cars) {
        const dx = camera.position.x - c.pos.x, dz = camera.position.z - c.pos.z;
        const h = Math.hypot(dx, dz);
        if (h < CLEAR) {
          const inv = h > 1e-3 ? 1 / h : 0;
          camera.position.x += dx * inv * (CLEAR - h);
          camera.position.z += dz * inv * (CLEAR - h);
          camera.position.y += 1.5;
        }
      }
      camera.lookAt(dampLook);
      if (Math.abs(camera.fov - fovTarget) > 0.01) { camera.fov += (fovTarget - camera.fov) * k; camera.updateProjectionMatrix(); }
    },
  };
}
