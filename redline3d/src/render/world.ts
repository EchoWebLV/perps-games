import * as THREE from "three";
import { type WorldTheme, type LampStyle, getTheme, loadThemeKey, saveThemeKey } from "./world-themes";
import { ROAD_GRADE_ANCHOR_Z, roadGradeOffset, roadGradeSlope } from "../core/market-road";
import type { MarketDirection } from "../core/market-pulse";
import { marketShockLightBoost } from "./market-shock";

export interface World {
  group: THREE.Group;
  /** speed = world units/sec; grade = price-driven road angle in degrees */
  update(dt: number, speed: number, grade: number): void;
  /** surface height at a given world z — objects ride this so they sit on the road */
  surfaceY(worldZ: number): number;
  /** Clown Car ability: split the road green (left=LONG) / red (right=SHORT) */
  setLaneBet(on: boolean): void;
  /** sudden-move pulse for road emission and the existing roadside lights */
  setMarketShock(amount: number, direction: MarketDirection): void;
  /** swap the level skin (sky, celestial, scenery, grid/road, lights) — see world-themes.ts */
  setTheme(key: string): void;
  /** the active skin key */
  currentTheme(): string;
}

const FREQ = 0.02;        // rolling-hill frequency (matches the shader literal)
const AMP = 3.2;          // rolling-hill amplitude
const PLANE_Z = -900;     // grid/road plane center in z
const GRADE_ANCHOR_LOCAL_Y = PLANE_Z - ROAD_GRADE_ANCHOR_Z;
const GRADE_TAU = 0.22;

type Junk = Array<{ dispose(): void }>;
const _WHITE = new THREE.Color(0xffffff);
/** a colour lerped `t` of the way toward white — for deriving bulb/halo tints from a lamp colour */
function tint(hex: string, t: number): THREE.Color {
  return new THREE.Color(hex).lerp(_WHITE, t);
}

/** white radial-alpha disc — tint via material.color for celestial halos */
function softDisc(): THREE.CanvasTexture {
  const s = 128, cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, "rgba(255,255,255,0.9)"); rg.addColorStop(0.35, "rgba(255,255,255,0.4)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

// ---------------- themed environment builders (sky · celestial · stars · scenery) ----------------
// Each builds in static world space from a theme and pushes its GPU resources to `junk` so the
// environment can be disposed + rebuilt when the skin changes.

function buildSky(theme: WorldTheme, junk: Junk): THREE.Object3D {
  const geo = new THREE.SphereGeometry(900, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: false,
    uniforms: { top: { value: new THREE.Color(theme.sky[0]) }, bot: { value: new THREE.Color(theme.sky[1]) } },
    vertexShader: `varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `varying float h; uniform vec3 top; uniform vec3 bot; void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*1.4+0.3,0.0,1.0)), 1.0);} `,
  });
  junk.push(geo, mat);
  return new THREE.Mesh(geo, mat);
}

function buildStars(theme: WorldTheme, junk: Junk, count = 320): THREE.Object3D {
  const geo = new THREE.BufferGeometry();
  const STAR_N = count;
  const sp = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i++) {
    sp[i * 3] = (Math.random() - 0.5) * 1700;
    sp[i * 3 + 1] = 120 + Math.random() * 520;
    sp[i * 3 + 2] = -300 - Math.random() * 760;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  const mat = new THREE.PointsMaterial({ color: theme.star, size: 2.4, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.85 });
  junk.push(geo, mat);
  return new THREE.Points(geo, mat);
}

function buildCelestial(theme: WorldTheme, junk: Junk): THREE.Object3D {
  switch (theme.celestial) {
    case "slicedSun": return buildSlicedSun(theme, junk);
    case "moon": return buildMoon(theme, junk);
    case "eclipse": return buildEclipse(theme, junk);
    default: return buildSlicedSun(theme, junk);
  }
}

function buildEclipse(theme: WorldTheme, junk: Junk): THREE.Group {
  // a blood-eclipse: a dark disc ringed by a glowing fiery corona, with a soft additive halo behind
  const g = new THREE.Group();
  const R = 124, X = 0, Y = 118, Z = -858; // 2× the original R=62; raised so the bigger disc stays framed
  const haloTex = softDisc();
  const haloGeo = new THREE.PlaneGeometry(R * 3.4, R * 3.4);
  const haloMat = new THREE.MeshBasicMaterial({ map: haloTex, color: theme.celestialColors[0], transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.75 });
  junk.push(haloTex, haloGeo, haloMat);
  const halo = new THREE.Mesh(haloGeo, haloMat); halo.position.set(X, Y, Z - 2); g.add(halo);
  const ringGeo = new THREE.RingGeometry(R * 0.9, R * 1.08, 64);
  const ringMat = new THREE.MeshBasicMaterial({ color: theme.celestialColors[1], transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, opacity: 0.95 });
  junk.push(ringGeo, ringMat);
  const ring = new THREE.Mesh(ringGeo, ringMat); ring.position.set(X, Y, Z - 0.5); g.add(ring);
  const discGeo = new THREE.CircleGeometry(R, 48);
  const discMat = new THREE.MeshBasicMaterial({ color: theme.celestialColors[2], fog: false });
  junk.push(discGeo, discMat);
  const disc = new THREE.Mesh(discGeo, discMat); disc.position.set(X, Y, Z); g.add(disc);
  return g;
}

function buildMoon(theme: WorldTheme, junk: Junk): THREE.Group {
  // a pale glowing disc with a soft halo + a few darker maria, hung off-centre in the sky
  const g = new THREE.Group();
  const R = 52, X = 118, Y = 116, Z = -858;
  const discGeo = new THREE.CircleGeometry(R, 48);
  const discMat = new THREE.MeshBasicMaterial({ color: theme.celestialColors[0], fog: false });
  junk.push(discGeo, discMat);
  const disc = new THREE.Mesh(discGeo, discMat); disc.position.set(X, Y, Z); g.add(disc);
  const mariaGeo = new THREE.CircleGeometry(R * 0.2, 20);
  const mariaMat = new THREE.MeshBasicMaterial({ color: theme.celestialColors[2], fog: false, transparent: true, opacity: 0.5 });
  junk.push(mariaGeo, mariaMat);
  for (const [ox, oy, s] of [[-16, 12, 1], [12, -6, 0.7], [20, 18, 0.5]] as const) {
    const m = new THREE.Mesh(mariaGeo, mariaMat); m.position.set(X + ox, Y + oy, Z + 0.3); m.scale.setScalar(s); g.add(m);
  }
  const haloTex = softDisc();
  const haloGeo = new THREE.PlaneGeometry(R * 3.4, R * 3.4);
  const haloMat = new THREE.MeshBasicMaterial({ map: haloTex, color: theme.celestialColors[1], transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.6 });
  junk.push(haloTex, haloGeo, haloMat);
  const halo = new THREE.Mesh(haloGeo, haloMat); halo.position.set(X, Y, Z - 1); g.add(halo);
  return g;
}

function buildSlicedSun(theme: WorldTheme, junk: Junk): THREE.Group {
  // a proper sliced retro sun: a circle cut by horizontal gaps, widest in the
  // middle, narrowing top + bottom, with a hi→mid→lo gradient
  const g = new THREE.Group();
  // 2× bigger and pushed well behind the mountains (their pyramids' near faces
  // reach in front of ~-800, so the sun must sit deeper than the whole range to
  // stop the peaks clipping through the disc). -860 keeps it inside the r=900 sky.
  const R = 116, CY = 74, Z = -860, N = 15;
  const top = new THREE.Color(theme.celestialColors[0]), mid = new THREE.Color(theme.celestialColors[1]), bot = new THREE.Color(theme.celestialColors[2]);
  const DROP_BOTTOM = 4;                  // skip the lowest slices — they dip below the horizon into the play area
  for (let i = 0; i < N - DROP_BOTTOM; i++) {
    const t = (i + 0.5) / N;              // 0 = top, 1 = bottom
    const yy = R - t * 2 * R;             // +R .. -R
    const w = 2 * Math.sqrt(Math.max(0.001, R * R - yy * yy));
    const barH = (2 * R / N) * 0.7;       // leaves a gap → the "slices"
    const c = new THREE.Color();
    if (t < 0.5) c.lerpColors(top, mid, t / 0.5);
    else c.lerpColors(mid, bot, (t - 0.5) / 0.5);
    const geo = new THREE.PlaneGeometry(w, barH);
    const mat = new THREE.MeshBasicMaterial({ color: c, fog: false });
    junk.push(geo, mat);
    const bar = new THREE.Mesh(geo, mat);
    bar.position.set(0, CY + yy, Z);
    g.add(bar);
  }
  return g;
}

function buildScenery(theme: WorldTheme, junk: Junk): THREE.Object3D {
  switch (theme.scenery) {
    case "mountains": return buildMountains(theme, junk);
    case "city": return buildCity(theme, junk);
    case "mesa": return buildMesa(theme, junk);
    case "ice": return buildIce(theme, junk);
    case "volcano": return buildVolcano(theme, junk);
    default: return buildMountains(theme, junk);
  }
}

function buildVolcano(theme: WorldTheme, junk: Junk): THREE.Group {
  // dark volcanic cones on the terrain shader, each with a bright lava cap + an additive summit
  // glow that bloom turns into a molten peak.
  const g = new THREE.Group();
  const rock = terrainMat(theme, junk);
  const lavaMat = new THREE.MeshBasicMaterial({ color: theme.sceneryColors.accent, fog: false });
  const glowTex = softDisc();
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, color: theme.sceneryColors.accent, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.8 });
  junk.push(lavaMat, glowTex, glowMat);
  for (let i = 0; i < 12; i++) {
    const h = 68 + Math.random() * 84;
    const r = 80 + Math.random() * 55;
    const px = -420 + i * 78 + (Math.random() - 0.5) * 30, py = h / 2 - 8, pz = -820 + (Math.random() - 0.5) * 50, ry = Math.random() * Math.PI;
    const geo = new THREE.ConeGeometry(r, h, 4).toNonIndexed(); geo.computeVertexNormals(); junk.push(geo);
    const c = new THREE.Mesh(geo, rock); c.position.set(px, py, pz); c.rotation.y = ry; g.add(c);
    const capH = 9 + Math.random() * 7;
    const capGeo = new THREE.ConeGeometry(r * 0.14, capH, 4).toNonIndexed(); capGeo.computeVertexNormals(); junk.push(capGeo);
    const cap = new THREE.Mesh(capGeo, lavaMat); cap.position.set(px, py + h / 2 - capH * 0.4, pz); cap.rotation.y = ry; g.add(cap);
    const glowGeo = new THREE.PlaneGeometry(r * 0.55, r * 0.55); junk.push(glowGeo);
    const glow = new THREE.Mesh(glowGeo, glowMat); glow.position.set(px, py + h / 2, pz + 2); g.add(glow);
  }
  return g;
}

function buildIce(theme: WorldTheme, junk: Junk): THREE.Group {
  // jagged ice spikes — sharp, tall 4-sided cones on the shared terrain shader (cold palette),
  // each tilted a touch so the field reads as broken ice rather than a tidy range.
  const g = new THREE.Group();
  const mat = terrainMat(theme, junk);
  for (let i = 0; i < 18; i++) {
    const r = 18 + Math.random() * 38;
    const h = 70 + Math.random() * 110;
    const geo = new THREE.ConeGeometry(r, h, 4).toNonIndexed();
    geo.computeVertexNormals();
    junk.push(geo);
    const c = new THREE.Mesh(geo, mat);
    c.position.set(-440 + i * 50 + (Math.random() - 0.5) * 30, h / 2 - 10, -820 + (Math.random() - 0.5) * 70);
    c.rotation.y = Math.random() * Math.PI;
    c.rotation.z = (Math.random() - 0.5) * 0.18; // slight tilt for jaggedness
    g.add(c);
  }
  return g;
}

/** drifting aurora curtains — an additive band wrapping the sky; returns a `tick` for world.update */
function buildAurora(junk: Junk): { obj: THREE.Object3D; tick: (t: number) => void } {
  const cv = document.createElement("canvas"); cv.width = 1024; cv.height = 512;
  const g = cv.getContext("2d")!;
  const cols = ["#2ee6a6", "#7fe8ff", "#6affb0", "#bfefff"];
  let seed = 91;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  g.filter = "blur(7px)";
  for (let i = 0; i < 14; i++) {
    const x = rnd() * cv.width, w = 40 + rnd() * 90, col = cols[Math.floor(rnd() * cols.length)];
    const top = 20 + rnd() * 90, bot = 250 + rnd() * 190;
    const grd = g.createLinearGradient(0, top, 0, bot);
    grd.addColorStop(0, "rgba(0,0,0,0)"); grd.addColorStop(0.4, col); grd.addColorStop(1, "rgba(0,0,0,0)");
    g.globalAlpha = 0.14 + rnd() * 0.18; g.fillStyle = grd; g.fillRect(x - w / 2, 0, w, cv.height);
  }
  g.filter = "none"; g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(2, 1);
  const geo = new THREE.CylinderGeometry(600, 600, 300, 48, 1, true);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, transparent: true, fog: false, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85 });
  junk.push(tex, geo, mat);
  const mesh = new THREE.Mesh(geo, mat); mesh.position.y = 150;
  return { obj: mesh, tick: (t) => { tex.offset.x = t * 0.01; } };
}

function buildCity(theme: WorldTheme, junk: Junk): THREE.Group {
  // a skyline of dark towers with lit windows + a neon silhouette rim — self-lit shader, like the
  // mountains, so it never touches the car/lamp lighting. Windows are a procedural grid (rows by
  // world-Y so spacing is constant, columns by face UV); ~40% lit, hashed per tower.
  const g = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      uBase: { value: new THREE.Color(theme.sceneryColors.base) },
      uWin: { value: new THREE.Color(theme.sceneryColors.accent) },
      uRim: { value: new THREE.Color(theme.sceneryColors.rim) },
    },
    vertexShader: `
      varying vec3 vPosW; varying vec3 vN; varying vec2 vUv;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying vec3 vPosW; varying vec3 vN; varying vec2 vUv;
      uniform vec3 uBase, uWin, uRim;
      float hash(float n){ return fract(sin(n) * 43758.5453); }
      void main(){
        vec3 n = normalize(vN);
        float roof = step(0.6, abs(n.y));                         // top/bottom faces = no windows
        float ry = floor(vPosW.y * 0.35), cx = floor(vUv.x * 5.0);
        float rowf = fract(vPosW.y * 0.35), colf = fract(vUv.x * 5.0);
        float cell = step(0.18, rowf) * step(rowf, 0.82) * step(0.15, colf) * step(colf, 0.85);
        float lit = cell * step(0.62, hash(ry * 7.0 + cx * 3.0 + floor(vPosW.x)));
        vec3 col = uBase + uWin * lit * 1.3 * (1.0 - roof);
        vec3 viewDir = normalize(cameraPosition - vPosW);
        float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.6);
        col += uRim * rim * 0.35;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  junk.push(mat);
  let seed = 1234;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 16; i++) {
    const w = 18 + rnd() * 24, d = 18 + rnd() * 24, h = 55 + rnd() * 120;
    const geo = new THREE.BoxGeometry(w, h, d);
    junk.push(geo);
    const c = new THREE.Mesh(geo, mat);
    c.position.set(-440 + i * 56 + (rnd() - 0.5) * 24, h / 2 - 6, -815 + (rnd() - 0.5) * 60);
    c.rotation.y = rnd() * 0.4 - 0.2;
    g.add(c);
  }
  return g;
}

/** the self-lit low-poly terrain shader shared by mountains + mesas: a dark base rising to a
 *  sun-lit peak, crisp facets (flat normals), and a neon silhouette rim that bloom turns into a
 *  glow. Self-contained, so it never touches the car / lamp lighting. */
function terrainMat(theme: WorldTheme, junk: Junk): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      uSun: { value: new THREE.Vector3(0, 74, -860) }, // tracks the sun behind the range
      uBase: { value: new THREE.Color(theme.sceneryColors.base) },
      uPeak: { value: new THREE.Color(theme.sceneryColors.peak) },
      uRim: { value: new THREE.Color(theme.sceneryColors.rim) },
    },
    vertexShader: `
      varying vec3 vPosW; varying vec3 vN; varying float vY;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz; vY = wp.y;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying vec3 vPosW; varying vec3 vN; varying float vY;
      uniform vec3 uSun, uBase, uPeak, uRim;
      void main(){
        vec3 n = normalize(vN);
        float hf = clamp((vY + 8.0) / 135.0, 0.0, 1.0);          // 0 foot .. 1 peak
        vec3 col = mix(uBase, uPeak, hf * hf);
        vec3 toSun = normalize(uSun - vPosW);
        col += uPeak * max(dot(n, toSun), 0.0) * 0.18;           // warm kick on sun-facing facets
        col *= 0.5 + 0.4 * (0.5 + 0.5 * dot(n, vec3(0.35, 0.45, 0.82))); // facet shading
        vec3 viewDir = normalize(cameraPosition - vPosW);
        float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.8);   // glowing silhouette edge
        col += uRim * rim * 0.3;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  junk.push(mat);
  return mat;
}

function buildMountains(theme: WorldTheme, junk: Junk): THREE.Group {
  const g = new THREE.Group();
  const mat = terrainMat(theme, junk);
  for (let i = 0; i < 12; i++) {
    const h = 90 + Math.random() * 90;
    const r = 90 + Math.random() * 60;
    // non-indexed + recomputed normals → flat per-facet shading (crisp low-poly look)
    const geo = new THREE.ConeGeometry(r, h, 4).toNonIndexed();
    geo.computeVertexNormals();
    junk.push(geo);
    const c = new THREE.Mesh(geo, mat);
    c.position.set(-420 + i * 78 + (Math.random() - 0.5) * 30, h / 2 - 8, -820 + (Math.random() - 0.5) * 50);
    c.rotation.y = Math.random() * Math.PI;
    g.add(c);
  }
  return g;
}

function buildMesa(theme: WorldTheme, junk: Junk): THREE.Group {
  // flat-topped buttes — same self-lit terrain shader, frustum geometry (wide base → narrow flat top)
  const g = new THREE.Group();
  const mat = terrainMat(theme, junk);
  for (let i = 0; i < 10; i++) {
    const botR = 55 + Math.random() * 60;
    const h = 40 + Math.random() * 62;
    const geo = new THREE.CylinderGeometry(botR * 0.62, botR, h, 4, 1).toNonIndexed();
    geo.computeVertexNormals();
    junk.push(geo);
    const c = new THREE.Mesh(geo, mat);
    c.position.set(-430 + i * 94 + (Math.random() - 0.5) * 30, h / 2 - 8, -820 + (Math.random() - 0.5) * 60);
    c.rotation.y = Math.random() * Math.PI;
    g.add(c);
  }
  return g;
}

// shared vertex displacement: rolling hills plus a car-anchored market grade. Anchoring the
// grade at the car makes the road ahead genuinely climb/drop instead of lifting the whole world.
const VERT = `
  varying vec2 vUv; uniform float uScroll; uniform float uAmp; uniform float uGrade; uniform float uGradeAnchor;
  void main(){
    vUv = uv;
    vec3 p = position;
    p.z += sin((position.y + uScroll) * ${FREQ}) * uAmp + (position.y - uGradeAnchor) * uGrade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
  }`;

// ---------------- per-level lamp fixtures ----------------
// Each theme's lampStyle picks a fixture builder. A builder creates its shared geometries once and
// returns `make(side, mats)` that assembles one lamp; `mats` is the theme-coloured material bundle
// for that side, and the returned `lights` array is what the flicker toggles. inward = -side reaches
// out over the road (a left lamp reaches +x, a right lamp reaches −x).
export interface LampMats { pole: THREE.Material; neon: THREE.Material; bulb: THREE.Material; halo: THREE.SpriteMaterial; beam: THREE.Material; }
type MakeLamp = (side: number, m: LampMats) => { root: THREE.Group; lights: THREE.Object3D[] };

function lampBuilder(style: LampStyle, junk: Junk): MakeLamp {
  switch (style) {
    case "arm": return lampArm(junk);
    case "cityDouble": return lampCityDouble(junk);
    case "utility": return lampUtility(junk);
    case "crystal": return lampCrystal(junk);
    case "brazier": return lampBrazier(junk);
    case "deco": return lampDeco(junk);
    default: return lampArm(junk);
  }
}

// synthwave — the original gooseneck arm lamp (pole + neon strip + arm over the road + hooded head + beam)
function lampArm(junk: Junk): MakeLamp {
  const poleGeo = new THREE.CylinderGeometry(0.3, 0.42, 13, 8);
  const footGeo = new THREE.CylinderGeometry(0.55, 0.72, 0.8, 8);
  const stripGeo = new THREE.BoxGeometry(0.08, 11.2, 0.18);
  const armGeo = new THREE.BoxGeometry(3.4, 0.24, 0.24);
  const houseGeo = new THREE.BoxGeometry(1.0, 0.55, 0.72);
  const bulbGeo = new THREE.BoxGeometry(0.78, 0.16, 0.52);
  const coneGeo = new THREE.ConeGeometry(2.2, 8, 14, 1, true);
  junk.push(poleGeo, footGeo, stripGeo, armGeo, houseGeo, bulbGeo, coneGeo);
  return (side, m) => {
    const inward = -side;
    const root = new THREE.Group();
    const pole = new THREE.Mesh(poleGeo, m.pole); pole.position.y = 6.5;
    const foot = new THREE.Mesh(footGeo, m.pole); foot.position.y = 0.4;
    const strip = new THREE.Mesh(stripGeo, m.neon); strip.position.set(inward * 0.36, 6.6, 0);
    const arm = new THREE.Mesh(armGeo, m.pole); arm.position.set(inward * 1.55, 12.7, 0); arm.rotation.z = inward * 0.08;
    const house = new THREE.Mesh(houseGeo, m.pole); house.position.set(inward * 3.05, 12.35, 0);
    const bulb = new THREE.Mesh(bulbGeo, m.bulb); bulb.position.set(inward * 3.05, 12.02, 0);
    const beam = new THREE.Mesh(coneGeo, m.beam); beam.position.set(inward * 3.05, 8, 0);
    const halo = new THREE.Sprite(m.halo); halo.scale.set(5.5, 5.5, 1); halo.position.set(inward * 3.05, 12.0, 0);
    root.add(pole, foot, strip, arm, house, bulb, beam, halo);
    return { root, lights: [strip, bulb, beam, halo] };
  };
}

// neon-city — a tall modern streetlight: a crossbar carrying two downlights + beams
function lampCityDouble(junk: Junk): MakeLamp {
  const poleGeo = new THREE.CylinderGeometry(0.26, 0.4, 16, 8);
  const footGeo = new THREE.CylinderGeometry(0.55, 0.72, 0.8, 8);
  const barGeo = new THREE.BoxGeometry(7, 0.26, 0.26);
  const headGeo = new THREE.BoxGeometry(0.9, 0.5, 0.6);
  const bulbGeo = new THREE.BoxGeometry(0.72, 0.16, 0.5);
  const coneGeo = new THREE.ConeGeometry(1.9, 7, 14, 1, true);
  junk.push(poleGeo, footGeo, barGeo, headGeo, bulbGeo, coneGeo);
  return (_side, m) => {
    const root = new THREE.Group();
    const pole = new THREE.Mesh(poleGeo, m.pole); pole.position.y = 8;
    const foot = new THREE.Mesh(footGeo, m.pole); foot.position.y = 0.4;
    const bar = new THREE.Mesh(barGeo, m.pole); bar.position.y = 15.6;
    root.add(pole, foot, bar);
    const lights: THREE.Object3D[] = [];
    for (const dx of [-2.9, 2.9]) {
      const head = new THREE.Mesh(headGeo, m.pole); head.position.set(dx, 15.2, 0);
      const bulb = new THREE.Mesh(bulbGeo, m.bulb); bulb.position.set(dx, 14.9, 0);
      const beam = new THREE.Mesh(coneGeo, m.beam); beam.position.set(dx, 11.4, 0);
      const halo = new THREE.Sprite(m.halo); halo.scale.set(4.6, 4.6, 1); halo.position.set(dx, 14.9, 0);
      root.add(head, bulb, beam, halo); lights.push(bulb, beam, halo);
    }
    return { root, lights };
  };
}

// desert — a rustic wooden utility pole: cross-arm + insulators + a bulb hanging over the road
function lampUtility(junk: Junk): MakeLamp {
  const wood = new THREE.MeshStandardMaterial({ color: "#3a2416", metalness: 0.1, roughness: 0.9 });
  const poleGeo = new THREE.CylinderGeometry(0.32, 0.42, 15, 7);
  const armGeo = new THREE.BoxGeometry(5, 0.3, 0.3);
  const insGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.35, 6);
  const wireGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 5);
  const bulbGeo = new THREE.SphereGeometry(0.42, 12, 10);
  junk.push(wood, poleGeo, armGeo, insGeo, wireGeo, bulbGeo);
  return (side, m) => {
    const inward = -side;
    const root = new THREE.Group();
    const pole = new THREE.Mesh(poleGeo, wood); pole.position.y = 7.5;
    const arm = new THREE.Mesh(armGeo, wood); arm.position.y = 13.4;
    const i1 = new THREE.Mesh(insGeo, wood); i1.position.set(-1.9, 13.7, 0);
    const i2 = new THREE.Mesh(insGeo, wood); i2.position.set(1.9, 13.7, 0);
    const wire = new THREE.Mesh(wireGeo, wood); wire.position.set(inward * 1.2, 12.5, 0);
    const bulb = new THREE.Mesh(bulbGeo, m.bulb); bulb.position.set(inward * 1.2, 11.6, 0);
    const halo = new THREE.Sprite(m.halo); halo.scale.set(4, 4, 1); halo.position.set(inward * 1.2, 11.6, 0);
    root.add(pole, arm, i1, i2, wire, bulb, halo);
    return { root, lights: [bulb, halo] };
  };
}

// ice — a glowing crystal spire (the light IS the crystal), with a bright inner core + halo
function lampCrystal(junk: Junk): MakeLamp {
  const spireGeo = new THREE.ConeGeometry(1.5, 13, 5).toNonIndexed(); spireGeo.computeVertexNormals();
  const coreGeo = new THREE.ConeGeometry(0.7, 11, 5);
  junk.push(spireGeo, coreGeo);
  return (side, m) => {
    const root = new THREE.Group();
    const spire = new THREE.Mesh(spireGeo, m.neon); spire.position.y = 6.5; spire.rotation.y = side * 0.4;
    const core = new THREE.Mesh(coreGeo, m.bulb); core.position.y = 6.2;
    const halo = new THREE.Sprite(m.halo); halo.scale.set(6, 6, 1); halo.position.y = 8;
    root.add(spire, core, halo);
    return { root, lights: [spire, core, halo] };
  };
}

// volcano — an iron post topped with a flaming brazier (the flames flicker via the lamp mode)
function lampBrazier(junk: Junk): MakeLamp {
  const iron = new THREE.MeshStandardMaterial({ color: "#1c1414", metalness: 0.7, roughness: 0.5 });
  const postGeo = new THREE.CylinderGeometry(0.4, 0.55, 11, 8);
  const bowlGeo = new THREE.CylinderGeometry(1.5, 0.7, 1.4, 10, 1);
  const flameGeo = new THREE.ConeGeometry(0.6, 2.6, 6);
  junk.push(iron, postGeo, bowlGeo, flameGeo);
  return (_side, m) => {
    const root = new THREE.Group();
    const post = new THREE.Mesh(postGeo, iron); post.position.y = 5.5;
    const bowl = new THREE.Mesh(bowlGeo, iron); bowl.position.y = 11.5;
    root.add(post, bowl);
    const flames: THREE.Object3D[] = [];
    const spec: [number, number, number, THREE.Material][] = [[0, 0, 1.2, m.bulb], [-0.5, 0.2, 0.9, m.neon], [0.5, -0.2, 0.9, m.neon], [0.1, 0.4, 0.7, m.neon]];
    for (const [dx, dz, s, mat] of spec) {
      const fl = new THREE.Mesh(flameGeo, mat); fl.position.set(dx, 12.6, dz); fl.scale.setScalar(s); root.add(fl); flames.push(fl);
    }
    const halo = new THREE.Sprite(m.halo); halo.scale.set(5, 5, 1); halo.position.set(0, 12.4, 0); root.add(halo); flames.push(halo);
    return { root, lights: flames };
  };
}

// miami — an art-deco post with tiered fins and a glowing globe on top
function lampDeco(junk: Junk): MakeLamp {
  const baseGeo = new THREE.CylinderGeometry(0.7, 0.9, 1.2, 8);
  const base2Geo = new THREE.CylinderGeometry(0.5, 0.7, 0.8, 8);
  const postGeo = new THREE.CylinderGeometry(0.2, 0.28, 12, 8);
  const finGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.12, 8);
  const orbGeo = new THREE.SphereGeometry(0.95, 16, 14);
  junk.push(baseGeo, base2Geo, postGeo, finGeo, orbGeo);
  return (_side, m) => {
    const root = new THREE.Group();
    const base = new THREE.Mesh(baseGeo, m.pole); base.position.y = 0.6;
    const base2 = new THREE.Mesh(base2Geo, m.pole); base2.position.y = 1.6;
    const post = new THREE.Mesh(postGeo, m.pole); post.position.y = 8;
    const f1 = new THREE.Mesh(finGeo, m.neon); f1.position.y = 5;
    const f2 = new THREE.Mesh(finGeo, m.neon); f2.position.y = 7; f2.scale.setScalar(0.85);
    const orb = new THREE.Mesh(orbGeo, m.bulb); orb.position.y = 13.4;
    const halo = new THREE.Sprite(m.halo); halo.scale.set(5.5, 5.5, 1); halo.position.y = 13.4;
    root.add(base, base2, post, f1, f2, orb, halo);
    return { root, lights: [f1, f2, orb, halo] };
  };
}

/** `detail` — "full" is the designed look, untouched on the high tier; "reduced" (low tier)
 *  halves the starfield, runs 2 roving point-lights per side instead of 3, and distance-culls
 *  the deep lamp corridor (the fog:false glow sprites otherwise draw ~40 lamps every frame). */
export function createWorld(detail: "full" | "reduced" = "full"): World {
  const group = new THREE.Group();
  const reduced = detail === "reduced";
  let shockAmount = 0;
  const shockColor = new THREE.Color("#2effc5");

  // ---- swappable environment (sky, celestial, stars, scenery) — rebuilt on setTheme() ----
  let envGroup: THREE.Group | null = null;
  let envAnim: ((t: number) => void) | null = null; // per-frame env motion (e.g. aurora drift), if any
  const envJunk: Junk = [];
  function buildEnv(theme: WorldTheme): void {
    if (envGroup) { group.remove(envGroup); for (const d of envJunk) d.dispose(); envJunk.length = 0; }
    envAnim = null;
    const g = new THREE.Group();
    g.add(buildSky(theme, envJunk));
    g.add(buildCelestial(theme, envJunk));
    g.add(buildStars(theme, envJunk, reduced ? 160 : 320));
    g.add(buildScenery(theme, envJunk));
    if (theme.aurora) { const a = buildAurora(envJunk); g.add(a.obj); envAnim = a.tick; }
    group.add(g);
    envGroup = g;
  }

  // neon grid floor (displaced by the shared wave) — persistent, recoloured on setTheme()
  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uScroll: { value: 0 }, uAmp: { value: AMP }, uGrade: { value: 0 }, uGradeAnchor: { value: GRADE_ANCHOR_LOCAL_Y }, uColor: { value: new THREE.Color("#ff39c0") }, uColor2: { value: new THREE.Color("#27e7ff") }, uShock: { value: 0 }, uShockColor: { value: shockColor.clone() } },
    vertexShader: VERT.replace("varying vec2 vUv;", "varying vec2 vUv; uniform float uOffset;"),
    fragmentShader: `
      varying vec2 vUv; uniform float uOffset; uniform vec3 uColor; uniform vec3 uColor2; uniform float uShock; uniform vec3 uShockColor;
      float line(float x){ float g = abs(fract(x)-0.5); return smoothstep(0.46,0.5,1.0-g*2.0); }
      void main(){
        float gx = line(vUv.x*40.0);
        float gz = line(vUv.y*160.0 + uOffset);
        float g = max(gx, gz);
        // hide grid lines under the road strip (grid-x ±13 -> vUv.x 0.484..0.516)
        // so they don't bleed through as extra lines in the distance
        g *= 1.0 - step(0.484, vUv.x) * step(vUv.x, 0.516);
        vec3 c = mix(mix(uColor2, uColor, vUv.x), uShockColor, uShock * 0.72);
        float fade = smoothstep(0.0, 0.35, vUv.y);
        gl_FragColor = vec4(c, min(1.0, g * fade * (1.0 + uShock * 0.65)));
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(800, 2000, 1, 160), gridMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, PLANE_Z);
  group.add(floor);

  // road strip (same wave)
  const roadMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uScroll: { value: 0 }, uAmp: { value: AMP }, uGrade: { value: 0 }, uGradeAnchor: { value: GRADE_ANCHOR_LOCAL_Y }, uEdge: { value: new THREE.Color("#ff39c0") }, uLane: { value: 0 }, uShock: { value: 0 }, uShockColor: { value: shockColor.clone() } },
    vertexShader: VERT.replace("varying vec2 vUv;", "varying vec2 vUv; uniform float uOffset;"),
    fragmentShader: `
      varying vec2 vUv; uniform float uOffset; uniform vec3 uEdge; uniform float uLane; uniform float uShock; uniform vec3 uShockColor;
      void main(){
        float edge = smoothstep(0.0,0.06,vUv.x) * smoothstep(1.0,0.94,vUv.x);
        float edges = 1.0 - edge;
        float dash = step(0.5, fract(vUv.y*90.0 + uOffset)) * step(0.46,vUv.x)*step(vUv.x,0.54);
        vec3 road = vec3(0.06,0.07,0.12);
        // Clown Car ability: left half green (LONG), right half red (SHORT)
        vec3 lane = mix(vec3(0.06,0.62,0.30), vec3(0.74,0.09,0.17), step(0.5, vUv.x));
        road = mix(road, lane, uLane);
        vec3 col = mix(road, uEdge, edges*0.9) + dash*vec3(0.9);
        col += uShockColor * uShock * (0.35 + edges * 0.75);
        // bright divider down the centre line while the ability is on
        col += uLane * smoothstep(0.014, 0.0, abs(vUv.x - 0.5)) * vec3(1.0);
        float fade = smoothstep(0.0,0.3,vUv.y);
        gl_FragColor = vec4(col, fade);
      }`,
  });
  const road = new THREE.Mesh(new THREE.PlaneGeometry(26, 2000, 1, 160), roadMat);
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.05, PLANE_Z);
  group.add(road);
  const scrollMats = [gridMat, roadMat]; // shared-uniform pair, hoisted off the per-frame path

  // roadside street lamps — the fixture DESIGN is per-theme (lampStyle), rebuilt on setTheme() by
  // buildLamps(); the scroll + recycle + flicker + the real point-lights below are shared by every
  // style. RECYCLE sits PAST the light fade (dist = RECYCLE - CAR_Z = 70 > 64) so a lamp is dark
  // when it teleports — recycling a still-lit lamp was the flicker.
  const SP = 44, COUNT = 22, TOTAL = SP * COUNT, RECYCLE = 58;
  // soft beam + halo textures — style-independent glows, created once and shared by every fixture
  const beamTex = (() => {
    const cv = document.createElement("canvas"); cv.width = 4; cv.height = 64;
    const g = cv.getContext("2d")!;
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0, "rgba(255,255,255,0.85)"); // top = at the bulb
    grd.addColorStop(0.5, "rgba(255,255,255,0.28)");
    grd.addColorStop(1, "rgba(255,255,255,0)");    // bottom = faded out, above the road
    g.fillStyle = grd; g.fillRect(0, 0, 4, 64);
    return new THREE.CanvasTexture(cv);
  })();
  const haloTex = (() => {
    const s = 128, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d")!;
    const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.22, "rgba(255,255,255,0.7)"); rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  })();

  type Lamp = { o: THREE.Group; lights: THREE.Object3D[]; mode: 0 | 1 | 2; seed: number; side: number };
  const lamps: Lamp[] = []; // rebuilt each theme by buildLamps()

  // a few REAL point-lights ride the lamps nearest the car, so the car + poles
  // actually get lit as lamps sweep past (the road/grid are custom shaders and
  // don't receive scene lights — the car catching the light is what sells it)
  // 3 per side — enough that the cutoff lamp is already past the fade (dark); the low tier
  // runs 2 per side (same continuity logic, one fewer live light in every lit shader)
  const LIGHT_N = reduced ? 4 : 6;
  const realLights: THREE.PointLight[] = [];
  for (let i = 0; i < LIGHT_N; i++) {
    const pl = new THREE.PointLight(0xffffff, 0, 36, 2);
    group.add(pl); // always present (intensity 0 when idle) so the light count never changes → no shader recompiles
    realLights.push(pl);
  }
  const colA = new THREE.Color("#3df0ff"), colB = new THREE.Color("#ff5ccf"); // point-light tints (left / right)
  const leftScratch: Lamp[] = [], rightScratch: Lamp[] = [];
  const lampOf: (Lamp | undefined)[] = []; // which lamp each real light currently tracks
  const CAR_Z = -12, REAL_I = 850;

  // ---- lamp fixtures: rebuilt per theme in the theme's lampStyle + colours ----
  let lampGroup: THREE.Group | null = null;
  const lampJunk: Junk = [];
  /** a theme-coloured material bundle for one lamp side (pole / neon / bulb / beam / halo) */
  function lampMats(hex: string): LampMats {
    const pole = new THREE.MeshStandardMaterial({ color: "#0c0e18", metalness: 0.6, roughness: 0.5, emissive: hex, emissiveIntensity: 1.05 });
    const neon = new THREE.MeshBasicMaterial({ color: hex, fog: false });
    const bulb = new THREE.MeshBasicMaterial({ color: tint(hex, 0.78), fog: false }); // near-white bulb glow
    const halo = new THREE.SpriteMaterial({ map: haloTex, color: tint(hex, 0.42), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95, fog: false });
    const beam = new THREE.MeshBasicMaterial({ color: hex, map: beamTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    lampJunk.push(pole, neon, bulb, halo, beam);
    return { pole, neon, bulb, halo, beam };
  }
  function buildLamps(theme: WorldTheme): void {
    if (lampGroup) { group.remove(lampGroup); for (const d of lampJunk) d.dispose(); lampJunk.length = 0; }
    lamps.length = 0;
    const g = new THREE.Group();
    const matsA = lampMats(theme.lights[0]); // left side
    const matsB = lampMats(theme.lights[1]); // right side
    const make = lampBuilder(theme.lampStyle, lampJunk);
    for (let i = 0; i < COUNT; i++) {
      for (const side of [-1, 1]) {
        const { root, lights } = make(side, side < 0 ? matsA : matsB);
        root.position.set(side * 15.5, 0, RECYCLE - i * SP);
        g.add(root);
        // most lamps lit; ~1/50 dead, ~1/43 flickering — for life
        const r = Math.random();
        const mode: 0 | 1 | 2 = r < 1 / 50 ? 1 : r < 1 / 50 + 1 / 43 ? 2 : 0;
        if (mode === 1) for (const m of lights) m.visible = false;
        lamps.push({ o: root, lights, mode, seed: i * 2.7 + side, side });
      }
    }
    colA.copy(tint(theme.lights[0], 0.12)); colB.copy(tint(theme.lights[1], 0.12)); // point-light tints
    lampGroup = g; group.add(g);
  }

  // ---- recolour the persistent road system (grid + road) from a theme (lamps are rebuilt, not recoloured) ----
  function recolorRoad(theme: WorldTheme): void {
    gridMat.uniforms.uColor.value.set(theme.grid[0]);
    gridMat.uniforms.uColor2.value.set(theme.grid[1]);
    roadMat.uniforms.uEdge.value.set(theme.roadEdge);
  }

  // ---- theme state ----
  let curKey = "";
  function setTheme(key: string): void {
    const theme = getTheme(key);
    recolorRoad(theme);
    buildEnv(theme);
    buildLamps(theme);
    curKey = theme.key;
    saveThemeKey(theme.key);
  }
  setTheme(loadThemeKey()); // build the initial environment + colours from the persisted skin

  let scroll = 0, gradeSlopeCur = 0, time = 0, laneTarget = 0;
  // the plane is rotated -90° about X and sits at z=PLANE_Z, so a world z maps to
  // local y = PLANE_Z - worldZ. sampling the wave here MUST match the vertex shader,
  // or objects float off the road (the "flying car" bug).
  const surfaceY = (worldZ: number) => {
    const localY = PLANE_Z - worldZ;
    return Math.sin((localY + scroll) * FREQ) * AMP + roadGradeOffset(worldZ, gradeSlopeCur);
  };

  // update()'s helpers, hoisted so the hot rAF path allocates no closures per frame
  const byCar = (a: Lamp, b: Lamp) => Math.abs(a.o.position.z - CAR_Z) - Math.abs(b.o.position.z - CAR_Z);
  const setLight = (idx: number, pl: THREE.PointLight, l: Lamp | undefined) => {
    let target = 0;
    if (l) {
      const inward = l.side < 0 ? 1 : -1;
      pl.position.set(l.o.position.x + inward * 3.05, l.o.position.y + 12, l.o.position.z);
      pl.color.copy(l.side < 0 ? colA : colB).lerp(shockColor, shockAmount * 0.72);
      const lit = l.mode === 2 ? l.lights[1].visible : true; // respect flicker
      const t = Math.max(0, 1 - Math.abs(l.o.position.z - CAR_Z) / 64);
      target = lit ? t * t * REAL_I * marketShockLightBoost(shockAmount) : 0;
    }
    // when a light HOPS to a different lamp, snap to that lamp's brightness instead
    // of carrying the old value across the teleport (that carry-over was the flicker).
    // Same lamp → smooth lerp as it sweeps past.
    if (lampOf[idx] !== l) { lampOf[idx] = l; pl.intensity = target; }
    else pl.intensity += (target - pl.intensity) * 0.3;
  };
  // low tier only: lamps deeper than this stop rendering. Their neon/halo/beam are fog:false
  // (the glow trail is meant to run to the horizon), so on "reduced" the trail ends here
  // instead — a dozen fixtures' draws saved per side. "full" never touches visibility.
  const LAMP_CULL_Z = -560;

  return {
    group,
    surfaceY,
    setLaneBet(on: boolean) { laneTarget = on ? 1 : 0; },
    setMarketShock(amount, direction) {
      shockAmount = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
      shockColor.set(direction < 0 ? "#ff326f" : "#2effc5");
    },
    setTheme,
    currentTheme: () => curKey,
    update(dt, speed, grade) {
      const flow = speed * dt;
      scroll += flow;
      time += dt;
      if (envAnim) envAnim(time); // aurora drift, etc.
      const gradeTarget = roadGradeSlope(grade);
      gradeSlopeCur += (gradeTarget - gradeSlopeCur) * (1 - Math.exp(-dt / GRADE_TAU));
      for (const mat of scrollMats) {
        mat.uniforms.uOffset.value += flow * 0.06;
        mat.uniforms.uScroll.value = scroll;
        mat.uniforms.uGrade.value = gradeSlopeCur;
        mat.uniforms.uShock.value = shockAmount;
        mat.uniforms.uShockColor.value.copy(shockColor);
      }
      // ease the lane-bet road tint in/out when the Clown Car is selected/deselected
      roadMat.uniforms.uLane.value += (laneTarget - roadMat.uniforms.uLane.value) * 0.1;
      for (const l of lamps) {
        l.o.position.z += flow;
        if (l.o.position.z > RECYCLE) l.o.position.z -= TOTAL;
        l.o.position.y = surfaceY(l.o.position.z);
        if (reduced) l.o.visible = l.o.position.z > LAMP_CULL_Z; // low tier: cull the deep corridor
        if (l.mode === 2) {
          // dying-lamp flicker: solid most of the time, fast buzz in the dips
          const ph = Math.sin(time * 12 + l.seed);
          const on = ph > -0.55 || Math.sin(time * 55 + l.seed) > 0;
          for (const m of l.lights) m.visible = on;
        }
      }
      // real lights: the two lamps straddling the car on EACH side, both kept lit and
      // cross-fading by distance → the sum is continuous, so the light never flickers
      // as lamps pass (mixing both sides + an odd light count was the flicker bug).
      leftScratch.length = 0; rightScratch.length = 0;
      for (const l of lamps) { if (l.mode === 1) continue; (l.side < 0 ? leftScratch : rightScratch).push(l); }
      leftScratch.sort(byCar); rightScratch.sort(byCar);
      const PER = LIGHT_N / 2;
      for (let i = 0; i < PER; i++) {
        setLight(i, realLights[i], leftScratch[i]);
        setLight(PER + i, realLights[PER + i], rightScratch[i]);
      }
    },
  };
}
