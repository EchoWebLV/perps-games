// Neon-night world around the circuit (DEV-ONLY, used by src/race-preview.ts). Everything the
// track's design language implies, in real 3D and heavily instanced: a gradient sky dome + moon +
// stars, two depth-rings of instanced box buildings with emissive window grids and Tron-style neon
// roof trims, blinking beacons + antennas, angled sponsor billboards, an animated light-streak
// highway ring, sweeping searchlights, instanced light poles with warm ground pools, industrial
// container stacks, and a dim mirrored copy of the neon (billboards + roof trims) below the floor
// that reads as a wet-asphalt reflection through the semi-transparent ground. Draw calls are kept
// low via InstancedMesh + shared canvas textures + additive depthWrite:false layers.
import * as THREE from "three";
import type { RaceTrack } from "./race-track";
import { toonifyWorld } from "./toon";

export interface RaceEnvironment {
  group: THREE.Group;
  update(dt: number): void;
  dispose(): void;
}

const NEON = [0x27e7ff, 0xff4dd2, 0xffd166, 0x41d67f, 0xb06bff];

function windowTexture(litProb: number): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 128; c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#05040c"; g.fillRect(0, 0, c.width, c.height);
  // a tower at night is mostly dark glass with scattered lit rooms — keep most windows dark
  const lit = ["#bcd4f0", "#ecc890", "#8fcff0", "#e6aad4", "#e8eef8"];
  const cols = 6, rows = 14, pad = 6;
  const cw = (c.width - pad * 2) / cols, ch = (c.height - pad * 2) / rows;
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
    const on = Math.random() < litProb;
    g.fillStyle = on ? lit[(Math.random() * lit.length) | 0] : "#0c0c18";
    g.fillRect(pad + col * cw + 1, pad + r * ch + 1, cw - 2, ch - 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function billboardTexture(label: string, hex: string): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 512; c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#080611"; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = hex; g.lineWidth = 14; g.strokeRect(16, 16, c.width - 32, c.height - 32);
  g.fillStyle = hex; g.font = "700 96px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = hex; g.shadowBlur = 30; g.fillText(label, c.width / 2, c.height / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function streakTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 256; c.height = 16;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  for (let x = 0; x < c.width; x += 22) {
    g.fillStyle = NEON.map((n) => "#" + n.toString(16))[(x / 22) % NEON.length | 0] as string;
    g.globalAlpha = 0.9; g.fillRect(x, 5, 12, 6);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function radialSprite(color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, color); grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createRaceEnvironment(track: RaceTrack): RaceEnvironment {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };
  const animators: Array<(t: number) => void> = [];
  const cx = track.center.x, cz = track.center.z;
  const R = track.boundingRadius;
  const dummy = new THREE.Object3D();

  // ---- sky gradient dome (deep violet horizon glow → near-black zenith) ----
  {
    const geo = keep(new THREE.SphereGeometry(R + 1400, 32, 20));
    const col = new Float32Array(geo.attributes.position.count * 3);
    const horizon = new THREE.Color(0x241247), zenith = new THREE.Color(0x030109);
    const p = geo.attributes.position;
    const tmp = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const ny = p.getY(i) / (R + 1400);
      const tt = Math.min(1, Math.max(0, (ny + 0.15) / 0.7));
      tmp.copy(horizon).lerp(zenith, tt);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const dome = new THREE.Mesh(geo, keep(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    dome.position.set(cx, 0, cz);
    group.add(dome);
  }

  // ---- moon disc low on one side + soft halo ----
  {
    const mx = cx - (R + 900), my = 220, mz = cz + (R + 500);
    const halo = new THREE.Mesh(keep(new THREE.CircleGeometry(150, 40)), keep(new THREE.MeshBasicMaterial({ map: keep(radialSprite("rgba(180,200,255,0.5)")), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    halo.position.set(mx, my, mz); halo.lookAt(cx, my, cz); group.add(halo);
    const moon = new THREE.Mesh(keep(new THREE.CircleGeometry(70, 48)), keep(new THREE.MeshBasicMaterial({ color: 0xdfe6ff, fog: false })));
    moon.position.set(mx, my, mz); moon.lookAt(cx, my, cz); group.add(moon);
  }

  // ---- stars ----
  {
    const SN = 500;
    const sp = new Float32Array(SN * 3);
    for (let i = 0; i < SN; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.random() * 0.6;
      const rr = (R + 1200) * (0.7 + Math.random() * 0.2);
      sp[i * 3] = cx + Math.cos(th) * Math.cos(ph) * rr;
      sp[i * 3 + 1] = 160 + Math.sin(ph) * 500;
      sp[i * 3 + 2] = cz + Math.sin(th) * Math.cos(ph) * rr;
    }
    const sg = keep(new THREE.BufferGeometry());
    sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    group.add(new THREE.Points(sg, keep(new THREE.PointsMaterial({ color: 0xbcccff, size: 2, transparent: true, opacity: 0.75, depthWrite: false, fog: false }))));
  }

  // ---- 3D city: two depth-rings of instanced buildings + neon roof trims. Moody-noir: buildings
  // are mostly dark glass with scattered lit rooms; the CLOSE ring (fills big screen area in race/
  // finish shots) is the DIMMEST, the distant ring stays a touch brighter for skyline depth. ----
  const trimTint = new THREE.Color();
  {
    const trimGeo = keep(new THREE.BoxGeometry(1, 1, 1));
    // one InstancedMesh per ring with its own dim window texture + emissive intensity (proximity)
    const rings = [
      { rad: R + 360, count: 52, hMin: 70, hMax: 220, litProb: 0.24, emissive: 1.05 }, // close → dim
      { rad: R + 700, count: 64, hMin: 100, hMax: 360, litProb: 0.36, emissive: 1.55 }, // far → brighter
    ];
    const total = rings.reduce((a, r) => a + r.count, 0);
    const trims = new THREE.InstancedMesh(trimGeo, keep(new THREE.MeshBasicMaterial({ toneMapped: false })), total);
    trims.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    const refl = new THREE.InstancedMesh(trimGeo, keep(new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })), total);
    refl.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    // faint roof pads on ~40% of buildings (halved) — just enough that roofs aren't black voids
    const roofGeo = keep(new THREE.PlaneGeometry(1, 1));
    const roofs = new THREE.InstancedMesh(roofGeo, keep(new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false })), total);
    roofs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    let ti = 0, ri = 0;
    const bodyGeo = keep(new THREE.BoxGeometry(1, 1, 1));
    for (const ring of rings) {
      const bodyMat = keep(new THREE.MeshStandardMaterial({ color: 0x0b0b16, emissive: 0xffffff, emissiveMap: keep(windowTexture(ring.litProb)), emissiveIntensity: ring.emissive, roughness: 0.85, metalness: 0.15 }));
      const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, ring.count);
      for (let k = 0; k < ring.count; k++) {
        const a = (k / ring.count) * Math.PI * 2 + Math.random() * 0.05;
        const rr = ring.rad + (Math.random() - 0.5) * 120;
        const w = 22 + Math.random() * 40, d = 22 + Math.random() * 40, h = ring.hMin + Math.random() * (ring.hMax - ring.hMin);
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
        const col = NEON[(Math.random() * NEON.length) | 0];
        trimTint.setHex(col);
        dummy.position.set(x, h / 2, z); dummy.rotation.set(0, -a, 0); dummy.scale.set(w, h, d);
        dummy.updateMatrix(); bodies.setMatrixAt(k, dummy.matrix);
        // faint roof pad on ~40% of buildings
        if (Math.random() < 0.4) {
          dummy.position.set(x, h + 0.4, z); dummy.rotation.set(-Math.PI / 2, 0, -a); dummy.scale.set(w * 0.7, d * 0.7, 1);
          dummy.updateMatrix(); roofs.setMatrixAt(ri, dummy.matrix); roofs.setColorAt(ri, trimTint); ri++;
        }
        // ~65% get a Tron-style neon roof-edge trim (accent — kept)
        if (Math.random() < 0.65) {
          dummy.position.set(x, h, z); dummy.rotation.set(0, -a, 0); dummy.scale.set(w + 3.5, 3.4, d + 3.5);
          dummy.updateMatrix();
          trims.setMatrixAt(ti, dummy.matrix); trims.setColorAt(ti, trimTint);
          dummy.position.set(x, -h, z); dummy.scale.set(w + 3.5, 3.4, d + 3.5); dummy.updateMatrix();
          refl.setMatrixAt(ti, dummy.matrix); refl.setColorAt(ti, trimTint);
          ti++;
        }
      }
      bodies.instanceMatrix.needsUpdate = true;
      group.add(bodies);
    }
    trims.count = ti; refl.count = ti; roofs.count = ri;
    trims.instanceMatrix.needsUpdate = true; refl.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true;
    if (trims.instanceColor) trims.instanceColor.needsUpdate = true;
    if (refl.instanceColor) refl.instanceColor.needsUpdate = true;
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
    refl.renderOrder = -2; // draw the reflection first (depthWrite:false) so the ground composites over it
    group.add(trims); group.add(refl); group.add(roofs); // building bodies were added per-ring above

    // blinking red rooftop beacons + a couple of antenna spires on the tall ring
    const beaconMat = keep(new THREE.MeshBasicMaterial({ color: 0xff3344, toneMapped: false }));
    const beacons: THREE.Mesh[] = [];
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2, rr = R + 620 + (Math.random() - 0.5) * 140;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr, h = 260 + Math.random() * 90;
      if (i < 2) { // antenna spire
        const ant = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.6, 1.4, 60, 6)), keep(new THREE.MeshBasicMaterial({ color: 0x1a1a2a })));
        ant.position.set(x, h + 30, z); group.add(ant);
      }
      const b = new THREE.Mesh(keep(new THREE.SphereGeometry(2.2, 8, 8)), beaconMat.clone());
      b.position.set(x, h + (i < 2 ? 62 : 4), z); group.add(b); beacons.push(b);
    }
    animators.push((t) => { for (let i = 0; i < beacons.length; i++) { const m = beacons[i].material as THREE.MeshBasicMaterial; m.opacity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 3 + i)); m.transparent = true; } });
  }

  // ---- mid-ground: angled sponsor billboards facing the track ----
  {
    const boards: Array<[string, number]> = [["OCTANE", 0x27e7ff], ["PERPS", 0xff4dd2], ["CRATES", 0xffd166], ["VRF", 0x41d67f]];
    boards.forEach(([label, hex], i) => {
      const a = (i / boards.length) * Math.PI * 2 + 0.6;
      const rr = R + 120;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      const bg = new THREE.Group(); bg.position.set(x, 26, z); bg.lookAt(cx, 26, cz); bg.rotation.y += 0.15;
      const frame = new THREE.Mesh(keep(new THREE.BoxGeometry(64, 34, 1.6)), keep(new THREE.MeshBasicMaterial({ color: hex, toneMapped: false })));
      const panel = new THREE.Mesh(keep(new THREE.PlaneGeometry(60, 30)), keep(new THREE.MeshBasicMaterial({ map: keep(billboardTexture(label, "#" + hex.toString(16))), toneMapped: false })));
      panel.position.z = 1.0; bg.add(frame); bg.add(panel);
      // legs
      const leg = new THREE.Mesh(keep(new THREE.BoxGeometry(2, 26, 2)), keep(new THREE.MeshBasicMaterial({ color: 0x14141f })));
      leg.position.set(0, -30, 0); bg.add(leg);
      group.add(bg);
      // dim reflection below
      const rp = panel.clone(); rp.position.set(x, -26, z); rp.lookAt(cx, -26, cz); rp.rotation.y += 0.15;
      (rp.material as THREE.Material) = keep(new THREE.MeshBasicMaterial({ map: (panel.material as THREE.MeshBasicMaterial).map, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      rp.scale.y = -1; rp.renderOrder = -2; group.add(rp);
    });
  }

  // ---- animated light-streak highway ring (two directions) ----
  {
    for (const [rad, dir, y] of [[R + 200, 1, 7], [R + 214, -1, 7]] as Array<[number, number, number]>) {
      const tex = keep(streakTexture()); tex.repeat.set(60, 1);
      const ring = new THREE.Mesh(
        keep(new THREE.RingGeometry(rad, rad + 6, 120)),
        keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })),
      );
      ring.rotation.x = -Math.PI / 2; ring.position.set(cx, y, cz); group.add(ring);
      animators.push((t) => { tex.offset.x = (t * 0.15 * dir) % 1; });
    }
  }

  // ---- sweeping searchlights (soft additive cones) ----
  {
    const coneGeo = keep(new THREE.ConeGeometry(16, 200, 20, 1, true));
    const cp = coneGeo.attributes.position; const cc = new Float32Array(cp.count * 3);
    for (let i = 0; i < cp.count; i++) { const tt = (cp.getY(i) + 100) / 200; const b = Math.pow(Math.max(0, tt), 1.5); cc[i * 3] = b; cc[i * 3 + 1] = b; cc[i * 3 + 2] = b; }
    coneGeo.setAttribute("color", new THREE.Float32BufferAttribute(cc, 3));
    for (let i = 0; i < 2; i++) {
      const a = i * Math.PI, rr = R + 90;
      const base = new THREE.Vector3(cx + Math.cos(a) * rr, 4, cz + Math.sin(a) * rr);
      const pivot = new THREE.Group(); pivot.position.copy(base); group.add(pivot);
      const mat = keep(new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xdfeaff, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false }));
      const cone = new THREE.Mesh(coneGeo, mat);
      cone.position.y = 100; cone.rotation.z = 0.5; pivot.add(cone);
      animators.push((t) => { pivot.rotation.y = Math.sin(t * 0.25 + i) * 0.9; });
    }
  }

  // ---- instanced light poles with warm ground glow pools + container-stack silhouettes ----
  {
    const poleGeo = keep(new THREE.BoxGeometry(1, 16, 1));
    const poleMat = keep(new THREE.MeshStandardMaterial({ color: 0x14141f, emissive: 0xffcf88, emissiveIntensity: 0.4, roughness: 0.7 }));
    const NP = 26;
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, NP);
    const poolTex = keep(radialSprite("rgba(255,190,120,0.5)"));
    const poolGeo = keep(new THREE.PlaneGeometry(26, 26));
    const pools = new THREE.InstancedMesh(poolGeo, keep(new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })), NP);
    for (let i = 0; i < NP; i++) {
      const a = (i / NP) * Math.PI * 2 + 0.2, rr = R + 60 + (Math.random() - 0.5) * 40;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      dummy.position.set(x, 8, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); poles.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, 0.1, z); dummy.rotation.set(-Math.PI / 2, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); pools.setMatrixAt(i, dummy.matrix);
    }
    poles.instanceMatrix.needsUpdate = true; pools.instanceMatrix.needsUpdate = true;
    group.add(poles); group.add(pools);

    // container stacks (dark industrial silhouettes) in a few clusters
    const conGeo = keep(new THREE.BoxGeometry(8, 4, 4));
    const conMat = keep(new THREE.MeshStandardMaterial({ color: 0x101020, roughness: 0.9 }));
    const NC = 90;
    const cons = new THREE.InstancedMesh(conGeo, conMat, NC);
    let ci = 0;
    for (let cl = 0; cl < 6 && ci < NC; cl++) {
      const a = Math.random() * Math.PI * 2, rr = R + 150 + Math.random() * 120;
      const bx0 = cx + Math.cos(a) * rr, bz0 = cz + Math.sin(a) * rr;
      for (let s = 0; s < 15 && ci < NC; s++) {
        const ox = (Math.random() - 0.5) * 30, oz = (Math.random() - 0.5) * 16, oy = (Math.floor(Math.random() * 3)) * 4 + 2;
        dummy.position.set(bx0 + ox, oy, bz0 + oz); dummy.rotation.set(0, Math.random() * 0.4, 0); dummy.scale.set(1, 1, 1);
        dummy.updateMatrix(); cons.setMatrixAt(ci, dummy.matrix); ci++;
      }
    }
    cons.count = ci; cons.instanceMatrix.needsUpdate = true; group.add(cons);
  }

  // cel-shade the lit solids (the instanced light poles + any standard-material props). The skyline
  // buildings glow through emissive-mapped windows, and the moon/stars/billboards/beacons/searchlights
  // are MeshBasic/Points/additive — all left to bloom. Instanced sources are toon'd, not outlined.
  const toonStats = toonifyWorld(group, { outlineWidth: 0.3, outlineMinSize: 4 });
  console.info(`[toon] race-environment: ${toonStats.toonMats} toon mats, ${toonStats.hulls} outline hulls, ${toonStats.instanced} instanced`);

  let t = 0;
  return {
    group,
    update(dt) { t += dt; for (const a of animators) a(t); },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
