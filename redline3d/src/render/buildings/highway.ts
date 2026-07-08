import * as THREE from "three";
import type { Track, BuiltBuilding } from "./types";

/** Number of amber merge chevrons painted on the apron, and how fast the chase sweeps. */
const CHEVRON_COUNT = 5;
const CHASE_STEP = 0.16; // seconds each chevron leads the crest

const CHEV_IDLE = 0.18;
const CHEV_LIT = 2.4;

/** A retroreflective freeway guide sign: interstate green with a white border, "HIGHWAY" and an
 *  up-right exit arrow. Self-lit so it reads at night against the dark lot. */
function guideTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 300;
  const g = c.getContext("2d")!;
  // green panel with a rounded white border
  g.fillStyle = "#157a3a";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "#eef6ef";
  g.lineWidth = 14;
  g.strokeRect(18, 18, c.width - 36, c.height - 36);
  // "HIGHWAY" — bold white, left of centre to leave room for the arrow
  g.fillStyle = "#f4faf5";
  g.font = "800 150px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText("HIGHWAY", 70, 158);
  // up-right exit arrow on the right
  g.strokeStyle = "#f4faf5";
  g.lineWidth = 26;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(770, 210);
  g.lineTo(905, 82); // shaft up-right
  g.stroke();
  g.beginPath(); // arrowhead
  g.moveTo(905, 82);
  g.lineTo(835, 88);
  g.moveTo(905, 82);
  g.lineTo(902, 152);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/** Freeway overpass: an overhead green guide-sign gantry, a raised deck with guardrails and passing
 *  traffic behind it, a dashed lane line, and an amber merge-arrow chase on the apron.
 *  Distinct from the TRACK's F1 start-gantry. Front (+Z) faces the plaza. */
export function buildHighway(color: number, track: Track): BuiltBuilding {
  const group = new THREE.Group();

  // ---- shared materials ----
  const body = track(
    new THREE.MeshStandardMaterial({
      color: 0x101826,
      emissive: color,
      emissiveIntensity: 0.14,
      metalness: 0.45,
      roughness: 0.55,
    }),
  );
  const concrete = track(
    new THREE.MeshStandardMaterial({ color: 0x2b303c, metalness: 0.1, roughness: 0.95 }),
  );
  const darkMetal = track(
    new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 0.7, roughness: 0.5 }),
  );
  const guardMetal = track(
    new THREE.MeshStandardMaterial({ color: 0x9aa2ad, metalness: 0.9, roughness: 0.4 }),
  );
  // building-colour edge neon — threads the assigned HIGHWAY orange through the deck + sign trim
  const neon = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 }),
  );
  const lane = track(
    new THREE.MeshStandardMaterial({ color: 0xdfe6ef, emissive: 0xdfe6ef, emissiveIntensity: 0.6 }),
  );

  // ================= OVERHEAD SIGN GANTRY =================
  const postGeo = track(new THREE.BoxGeometry(1.2, 15, 1.2));
  const postL = new THREE.Mesh(postGeo, darkMetal);
  postL.position.set(-14, 7.5, 3);
  group.add(postL);
  const postR = new THREE.Mesh(postGeo, darkMetal);
  postR.position.set(14, 7.5, 3);
  group.add(postR);

  const beamGeo = track(new THREE.BoxGeometry(30, 1.2, 1.4));
  const beam = new THREE.Mesh(beamGeo, body);
  beam.position.set(0, 14.4, 3);
  group.add(beam);

  // a couple of truss diagonals under the beam for an overhead-gantry look
  const trussGeo = track(new THREE.BoxGeometry(0.22, 3.2, 0.22));
  for (const tx of [-10, -3.4, 3.4, 10]) {
    const d = new THREE.Mesh(trussGeo, darkMetal);
    d.position.set(tx, 12.6, 3);
    d.rotation.z = (tx % 6.8 === 0 ? 1 : -1) * 0.5;
    group.add(d);
  }

  // green guide sign hung between the posts, just under the beam, facing +Z
  const signBackGeo = track(new THREE.BoxGeometry(20, 6.4, 0.3));
  const signBack = new THREE.Mesh(signBackGeo, darkMetal);
  signBack.position.set(0, 10.4, 3.35);
  group.add(signBack);

  const guideTex = track(guideTexture());
  const guideMat = track(
    new THREE.MeshStandardMaterial({
      map: guideTex,
      emissive: 0xffffff,
      emissiveMap: guideTex,
      emissiveIntensity: 0.9,
      roughness: 0.6,
    }),
  );
  const signFaceGeo = track(new THREE.PlaneGeometry(19, 5.6));
  const signFace = new THREE.Mesh(signFaceGeo, guideMat);
  signFace.position.set(0, 10.4, 3.52);
  group.add(signFace);

  // thin building-colour strip under the sign, tying the gantry to the HIGHWAY neon name above
  const signStripGeo = track(new THREE.BoxGeometry(19.2, 0.16, 0.2));
  const signStrip = new THREE.Mesh(signStripGeo, neon);
  signStrip.position.set(0, 7.0, 3.5);
  group.add(signStrip);

  // ================= RAISED OVERPASS DECK (behind the gantry, -Z) =================
  const DECK_Z = -4;
  const DECK_Y = 7;
  const pierGeo = track(new THREE.BoxGeometry(2, DECK_Y, 2.2));
  for (const px of [-11, 0, 11]) {
    const pier = new THREE.Mesh(pierGeo, concrete);
    pier.position.set(px, DECK_Y / 2, DECK_Z);
    group.add(pier);
  }

  const deckGeo = track(new THREE.BoxGeometry(31, 0.8, 4.4));
  const deck = new THREE.Mesh(deckGeo, concrete);
  deck.position.set(0, DECK_Y + 0.4, DECK_Z);
  group.add(deck);

  // building-colour edge strip along the deck's front lip so the overpass silhouette glows
  const deckEdgeGeo = track(new THREE.BoxGeometry(31, 0.12, 0.16));
  const deckEdge = new THREE.Mesh(deckEdgeGeo, neon);
  deckEdge.position.set(0, DECK_Y + 0.86, DECK_Z + 2.2);
  group.add(deckEdge);

  // W-beam guardrails: a low galvanised rail on short posts along both deck edges
  const railGeo = track(new THREE.BoxGeometry(30.5, 0.5, 0.12));
  const railPostGeo = track(new THREE.BoxGeometry(0.16, 0.95, 0.16));
  for (const rz of [DECK_Z + 2.0, DECK_Z - 2.0]) {
    const rail = new THREE.Mesh(railGeo, guardMetal);
    rail.position.set(0, DECK_Y + 1.35, rz);
    group.add(rail);
    for (let px = -14; px <= 14; px += 3.5) {
      const rp = new THREE.Mesh(railPostGeo, guardMetal);
      rp.position.set(px, DECK_Y + 1.05, rz);
      group.add(rp);
    }
  }

  // passing traffic on the deck: dots that slide across (red tail-lights, white headlights), wrapped
  const trafficDotGeo = track(new THREE.SphereGeometry(0.22, 8, 6));
  const redMat = track(
    new THREE.MeshStandardMaterial({ color: 0xff3a2a, emissive: 0xff3a2a, emissiveIntensity: 1.8 }),
  );
  const whiteMat = track(
    new THREE.MeshStandardMaterial({ color: 0xfff2d8, emissive: 0xfff2d8, emissiveIntensity: 1.8 }),
  );
  // dir +1 slides +X, -1 slides -X; offset spreads them along the span; the two lanes sit front/back
  const traffic: Array<{ dot: THREE.Mesh; dir: number; off: number; lane: number }> = [
    { dot: new THREE.Mesh(trafficDotGeo, redMat), dir: 1, off: 0.0, lane: DECK_Z + 1.0 },
    { dot: new THREE.Mesh(trafficDotGeo, redMat), dir: 1, off: 0.45, lane: DECK_Z + 1.0 },
    { dot: new THREE.Mesh(trafficDotGeo, redMat), dir: 1, off: 0.8, lane: DECK_Z + 1.0 },
    { dot: new THREE.Mesh(trafficDotGeo, whiteMat), dir: -1, off: 0.25, lane: DECK_Z - 1.0 },
    { dot: new THREE.Mesh(trafficDotGeo, whiteMat), dir: -1, off: 0.7, lane: DECK_Z - 1.0 },
  ];
  for (const c of traffic) {
    c.dot.position.set(0, DECK_Y + 1.05, c.lane);
    group.add(c.dot);
  }

  // ================= DASHED LANE LINE + EDGE LINES (front apron) =================
  const dashGeo = track(new THREE.BoxGeometry(1.1, 0.06, 2.2));
  for (let i = 0; i < 4; i++) {
    const dash = new THREE.Mesh(dashGeo, lane);
    dash.position.set(0, 0.06, 8 - i * 3.2); // marching toward the gantry
    group.add(dash);
  }
  const edgeGeo = track(new THREE.BoxGeometry(0.22, 0.06, 12));
  for (const ex of [-6, 6]) {
    const edge = new THREE.Mesh(edgeGeo, lane);
    edge.position.set(ex, 0.06, 3.5);
    group.add(edge);
  }

  // ================= AMBER MERGE-ARROW CHASE (apron, replaces the F1 light tree) =================
  // Flat triangle chevrons pointing +Z (toward the plaza / entrance) that light back-to-front, a
  // highway lane-merge board that doubles as a "this way in" cue.
  const chevronGeo = track(new THREE.ConeGeometry(1.15, 1.7, 3));
  const chevronMats: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < CHEVRON_COUNT; i++) {
    const mat = track(
      new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffb020, emissiveIntensity: CHEV_IDLE }),
    );
    chevronMats.push(mat);
    const chev = new THREE.Mesh(chevronGeo, mat);
    chev.rotation.x = -Math.PI / 2; // apex from +Y to +Z
    chev.position.set(0, 0.12, -0.5 + i * 1.7);
    group.add(chev);
  }

  // slow amber flasher beacon atop the +X post (highway warning light)
  const beaconMat = track(
    new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffb020, emissiveIntensity: 1.4 }),
  );
  const beaconGeo = track(new THREE.SphereGeometry(0.5, 12, 10));
  const beacon = new THREE.Mesh(beaconGeo, beaconMat);
  beacon.position.set(14, 15.4, 3);
  group.add(beacon);

  // ================= ANIMATE =================
  const SPAN = 30; // traffic wraps across this width, centred on 0
  const animate = (t: number): void => {
    // merge chevrons chase from back to front
    const crest = Math.floor(t / CHASE_STEP) % (CHEVRON_COUNT + 2);
    for (let i = 0; i < CHEVRON_COUNT; i++) {
      chevronMats[i].emissiveIntensity = i === crest || i === crest - 1 ? CHEV_LIT : CHEV_IDLE;
    }
    // passing traffic slides along the deck and wraps
    for (const c of traffic) {
      const p = ((t * 0.16 + c.off) % 1); // 0..1 along the span
      c.dot.position.x = c.dir > 0 ? -SPAN / 2 + p * SPAN : SPAN / 2 - p * SPAN;
    }
    // building-colour neon breathes; amber beacon does a sharp slow blink
    neon.emissiveIntensity = 1.5 + 0.3 * Math.sin(t * 1.7);
    beaconMat.emissiveIntensity = 0.4 + 1.6 * Math.pow(0.5 + 0.5 * Math.sin(t * 2.0), 6);
  };

  return { group, signY: 18, frontZ: 6, animate };
}
