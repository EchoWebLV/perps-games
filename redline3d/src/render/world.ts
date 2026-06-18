import * as THREE from "three";

export interface World {
  group: THREE.Group;
  /** speed = world units/sec; bias = price-driven elevation (the road climbs on a pump, dips on a dump) */
  update(dt: number, speed: number, bias: number): void;
  /** surface height at a given world z — objects ride this so they sit on the road */
  surfaceY(worldZ: number): number;
}

const FREQ = 0.02;        // rolling-hill frequency (matches the shader literal)
const AMP = 3.2;          // rolling-hill amplitude
const PLANE_Z = -900;     // grid/road plane center in z

function makeSun(): THREE.Group {
  // a proper sliced retro sun: a circle cut by horizontal gaps, widest in the
  // middle, narrowing top + bottom, with a yellow→magenta gradient
  const g = new THREE.Group();
  // 2× bigger and pushed well behind the mountains (their pyramids' near faces
  // reach in front of ~-800, so the sun must sit deeper than the whole range to
  // stop the peaks clipping through the disc). -860 keeps it inside the r=900 sky.
  const R = 116, CY = 74, Z = -860, N = 15;
  const top = new THREE.Color("#fff27a"), mid = new THREE.Color("#ff7a3c"), bot = new THREE.Color("#ff2d9a");
  const DROP_BOTTOM = 4;                  // skip the lowest slices — they dip below the horizon into the play area
  for (let i = 0; i < N - DROP_BOTTOM; i++) {
    const t = (i + 0.5) / N;              // 0 = top, 1 = bottom
    const yy = R - t * 2 * R;             // +R .. -R
    const w = 2 * Math.sqrt(Math.max(0.001, R * R - yy * yy));
    const barH = (2 * R / N) * 0.7;       // leaves a gap → the "slices"
    const c = new THREE.Color();
    if (t < 0.5) c.lerpColors(top, mid, t / 0.5);
    else c.lerpColors(mid, bot, (t - 0.5) / 0.5);
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, barH), new THREE.MeshBasicMaterial({ color: c, fog: false }));
    bar.position.set(0, CY + yy, Z);
    g.add(bar);
  }
  return g;
}

// shared vertex displacement: a rolling wave (sin) plus a price-driven bias, scrolling toward the camera
const VERT = `
  varying vec2 vUv; uniform float uScroll; uniform float uAmp; uniform float uBias;
  void main(){
    vUv = uv;
    vec3 p = position;
    p.z += sin((position.y + uScroll) * ${FREQ}) * uAmp + uBias;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
  }`;

export function createWorld(): World {
  const group = new THREE.Group();

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, fog: false,
      uniforms: { top: { value: new THREE.Color("#160a2e") }, bot: { value: new THREE.Color("#7a1d5e") } },
      vertexShader: `varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
      fragmentShader: `varying float h; uniform vec3 top; uniform vec3 bot; void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*1.4+0.3,0.0,1.0)), 1.0);} `,
    })
  );
  group.add(sky);
  group.add(makeSun());

  // stars
  const starGeo = new THREE.BufferGeometry();
  const STAR_N = 320;
  const sp = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i++) {
    sp[i * 3] = (Math.random() - 0.5) * 1700;
    sp[i * 3 + 1] = 120 + Math.random() * 520;
    sp[i * 3 + 2] = -300 - Math.random() * 760;
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  group.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: "#cfe0ff", size: 2.4, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.85 })));

  // mountains — a self-lit shader gives them real form instead of flat cutouts:
  // a dark base rising to a warm, sun-lit peak, crisp low-poly facets (flat
  // normals), and a neon rim on the silhouette that bloom turns into a glow.
  // Self-contained, so it never touches the car / lamp lighting.
  const mtnMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      uSun: { value: new THREE.Vector3(0, 74, -860) }, // tracks the sun behind the range
      uBase: { value: new THREE.Color("#120620") },    // near-black foot
      uPeak: { value: new THREE.Color("#5d1c44") },    // muted magenta toward the top
      uRim: { value: new THREE.Color("#c64f9e") },     // soft silhouette edge
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
  for (let i = 0; i < 12; i++) {
    const h = 90 + Math.random() * 90;
    const r = 90 + Math.random() * 60;
    // non-indexed + recomputed normals → flat per-facet shading (crisp low-poly look)
    const geo = new THREE.ConeGeometry(r, h, 4).toNonIndexed();
    geo.computeVertexNormals();
    const c = new THREE.Mesh(geo, mtnMat);
    c.position.set(-420 + i * 78 + (Math.random() - 0.5) * 30, h / 2 - 8, -820 + (Math.random() - 0.5) * 50);
    c.rotation.y = Math.random() * Math.PI;
    group.add(c);
  }

  // neon grid floor (displaced by the shared wave)
  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uScroll: { value: 0 }, uAmp: { value: AMP }, uBias: { value: 0 }, uColor: { value: new THREE.Color("#ff39c0") }, uColor2: { value: new THREE.Color("#27e7ff") } },
    vertexShader: VERT.replace("varying vec2 vUv;", "varying vec2 vUv; uniform float uOffset;"),
    fragmentShader: `
      varying vec2 vUv; uniform float uOffset; uniform vec3 uColor; uniform vec3 uColor2;
      float line(float x){ float g = abs(fract(x)-0.5); return smoothstep(0.46,0.5,1.0-g*2.0); }
      void main(){
        float gx = line(vUv.x*40.0);
        float gz = line(vUv.y*160.0 + uOffset);
        float g = max(gx, gz);
        // hide grid lines under the road strip (grid-x ±13 -> vUv.x 0.484..0.516)
        // so they don't bleed through as extra lines in the distance
        g *= 1.0 - step(0.484, vUv.x) * step(vUv.x, 0.516);
        vec3 c = mix(uColor2, uColor, vUv.x);
        float fade = smoothstep(0.0, 0.35, vUv.y);
        gl_FragColor = vec4(c, g * fade);
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(800, 2000, 1, 160), gridMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, PLANE_Z);
  group.add(floor);

  // road strip (same wave)
  const roadMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uScroll: { value: 0 }, uAmp: { value: AMP }, uBias: { value: 0 }, uEdge: { value: new THREE.Color("#ff39c0") } },
    vertexShader: VERT.replace("varying vec2 vUv;", "varying vec2 vUv; uniform float uOffset;"),
    fragmentShader: `
      varying vec2 vUv; uniform float uOffset; uniform vec3 uEdge;
      void main(){
        float edge = smoothstep(0.0,0.06,vUv.x) * smoothstep(1.0,0.94,vUv.x);
        float edges = 1.0 - edge;
        float dash = step(0.5, fract(vUv.y*90.0 + uOffset)) * step(0.46,vUv.x)*step(vUv.x,0.54);
        vec3 road = vec3(0.06,0.07,0.12);
        vec3 col = mix(road, uEdge, edges*0.9) + dash*vec3(0.9);
        float fade = smoothstep(0.0,0.3,vUv.y);
        gl_FragColor = vec4(col, fade);
      }`,
  });
  const road = new THREE.Mesh(new THREE.PlaneGeometry(26, 2000, 1, 160), roadMat);
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.05, PLANE_Z);
  group.add(road);

  // roadside street lamps (also the speed cue) — pole + arm + glowing head + a
  // soft light shaft to the road, plus a neon strip up the pole. They ride the surface.
  // RECYCLE sits PAST the light fade (dist = RECYCLE - CAR_Z = 70 > 64) so a lamp is
  // already dark when it teleports — recycling a still-lit lamp was the flicker.
  const SP = 44, COUNT = 22, TOTAL = SP * COUNT, RECYCLE = 58;
  const poleGeo = new THREE.CylinderGeometry(0.3, 0.42, 13, 8);
  const footGeo = new THREE.CylinderGeometry(0.55, 0.72, 0.8, 8);
  const stripGeo = new THREE.BoxGeometry(0.08, 11.2, 0.18);
  const armGeo = new THREE.BoxGeometry(3.4, 0.24, 0.24);
  const houseGeo = new THREE.BoxGeometry(1.0, 0.55, 0.72);
  const bulbGeo = new THREE.BoxGeometry(0.78, 0.16, 0.52);
  const coneGeo = new THREE.ConeGeometry(2.2, 8, 14, 1, true);
  // the pole itself glows a little in its side colour (like the original neon pillars)
  const poleCyan = new THREE.MeshStandardMaterial({ color: "#0c0e18", metalness: 0.6, roughness: 0.5, emissive: "#27e7ff", emissiveIntensity: 1.05 });
  const poleMag = new THREE.MeshStandardMaterial({ color: "#120814", metalness: 0.6, roughness: 0.5, emissive: "#ff39c0", emissiveIntensity: 1.05 });
  const bulbCyan = new THREE.MeshBasicMaterial({ color: "#d6fbff", fog: false });
  const bulbMag = new THREE.MeshBasicMaterial({ color: "#ffd6f6", fog: false });
  const stripCyan = new THREE.MeshBasicMaterial({ color: "#27e7ff", fog: false });
  const stripMag = new THREE.MeshBasicMaterial({ color: "#ff39c0", fog: false });
  // soft beam: bright at the bulb, gradient-fading to nothing before the ground
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
  const coneOpt = { map: beamTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false } as const;
  const coneCyan = new THREE.MeshBasicMaterial({ color: "#27e7ff", ...coneOpt });
  const coneMag = new THREE.MeshBasicMaterial({ color: "#ff39c0", ...coneOpt });
  // glowing halo at the lamp head — the soft orb of light that reads as an actual lamp (bloom amplifies it)
  const haloTex = (() => {
    const s = 128, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d")!;
    const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.22, "rgba(255,255,255,0.7)"); rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  })();
  const haloCyan = new THREE.SpriteMaterial({ map: haloTex, color: "#86eaff", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95, fog: false });
  const haloMag = new THREE.SpriteMaterial({ map: haloTex, color: "#ff86e0", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95, fog: false });

  type Lamp = { o: THREE.Group; lights: THREE.Object3D[]; mode: 0 | 1 | 2; seed: number; side: number };
  const lamps: Lamp[] = [];
  for (let i = 0; i < COUNT; i++) {
    for (const side of [-1, 1]) {
      const left = side < 0;
      const inward = -side; // arm reaches in over the road
      const poleMat = left ? poleCyan : poleMag;
      const o = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat); pole.position.y = 6.5;
      const foot = new THREE.Mesh(footGeo, poleMat); foot.position.y = 0.4;
      const sStrip = new THREE.Mesh(stripGeo, left ? stripCyan : stripMag); sStrip.position.set(inward * 0.36, 6.6, 0);
      const arm = new THREE.Mesh(armGeo, poleMat); arm.position.set(inward * 1.55, 12.7, 0); arm.rotation.z = inward * 0.08;
      const house = new THREE.Mesh(houseGeo, poleMat); house.position.set(inward * 3.05, 12.35, 0);
      const b = new THREE.Mesh(bulbGeo, left ? bulbCyan : bulbMag); b.position.set(inward * 3.05, 12.02, 0);
      const c = new THREE.Mesh(coneGeo, left ? coneCyan : coneMag); c.position.set(inward * 3.05, 8, 0);
      const halo = new THREE.Sprite(left ? haloCyan : haloMag); halo.scale.set(5.5, 5.5, 1); halo.position.set(inward * 3.05, 12.0, 0);
      o.add(pole, foot, sStrip, arm, house, b, c, halo);
      o.position.set(side * 15.5, 0, RECYCLE - i * SP);
      group.add(o);
      // most lamps lit; ~1/50 dead, ~1/43 flickering — for life
      const r = Math.random();
      const mode: 0 | 1 | 2 = r < 1 / 50 ? 1 : r < 1 / 50 + 1 / 43 ? 2 : 0;
      const lights: THREE.Object3D[] = [sStrip, b, c, halo];
      if (mode === 1) for (const m of lights) m.visible = false;
      lamps.push({ o, lights, mode, seed: i * 2.7 + side, side });
    }
  }

  // a few REAL point-lights ride the lamps nearest the car, so the car + poles
  // actually get lit as lamps sweep past (the road/grid are custom shaders and
  // don't receive scene lights — the car catching the light is what sells it)
  const LIGHT_N = 6; // 3 per side — enough that the cutoff lamp is already past the fade (dark)
  const realLights: THREE.PointLight[] = [];
  for (let i = 0; i < LIGHT_N; i++) {
    const pl = new THREE.PointLight(0xffffff, 0, 36, 2);
    group.add(pl); // always present (intensity 0 when idle) so the light count never changes → no shader recompiles
    realLights.push(pl);
  }
  const cyanCol = new THREE.Color("#3df0ff"), magCol = new THREE.Color("#ff5ccf");
  const leftScratch: Lamp[] = [], rightScratch: Lamp[] = [];
  const lampOf: (Lamp | undefined)[] = []; // which lamp each real light currently tracks
  const CAR_Z = -12, REAL_I = 850;

  let scroll = 0, biasCur = 0, time = 0;
  // the plane is rotated -90° about X and sits at z=PLANE_Z, so a world z maps to
  // local y = PLANE_Z - worldZ. sampling the wave here MUST match the vertex shader,
  // or objects float off the road (the "flying car" bug).
  const surfaceY = (worldZ: number) => {
    const localY = PLANE_Z - worldZ;
    return Math.sin((localY + scroll) * FREQ) * AMP + biasCur;
  };

  return {
    group,
    surfaceY,
    update(dt, speed, bias) {
      const flow = speed * dt;
      scroll += flow;
      time += dt;
      biasCur += (bias - biasCur) * 0.06;
      for (const mat of [gridMat, roadMat]) {
        mat.uniforms.uOffset.value += flow * 0.06;
        mat.uniforms.uScroll.value = scroll;
        mat.uniforms.uBias.value = biasCur;
      }
      for (const l of lamps) {
        l.o.position.z += flow;
        if (l.o.position.z > RECYCLE) l.o.position.z -= TOTAL;
        l.o.position.y = surfaceY(l.o.position.z);
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
      const byCar = (a: Lamp, b: Lamp) => Math.abs(a.o.position.z - CAR_Z) - Math.abs(b.o.position.z - CAR_Z);
      leftScratch.sort(byCar); rightScratch.sort(byCar);
      const setLight = (idx: number, pl: THREE.PointLight, l: Lamp | undefined) => {
        let target = 0;
        if (l) {
          const inward = l.side < 0 ? 1 : -1;
          pl.position.set(l.o.position.x + inward * 3.05, l.o.position.y + 12, l.o.position.z);
          pl.color.copy(l.side < 0 ? cyanCol : magCol);
          const lit = l.mode === 2 ? l.lights[1].visible : true; // respect flicker
          const t = Math.max(0, 1 - Math.abs(l.o.position.z - CAR_Z) / 64);
          target = lit ? t * t * REAL_I : 0;
        }
        // when a light HOPS to a different lamp, snap to that lamp's brightness instead
        // of carrying the old value across the teleport (that carry-over was the flicker).
        // Same lamp → smooth lerp as it sweeps past.
        if (lampOf[idx] !== l) { lampOf[idx] = l; pl.intensity = target; }
        else pl.intensity += (target - pl.intensity) * 0.3;
      };
      const PER = LIGHT_N / 2;
      for (let i = 0; i < PER; i++) {
        setLight(i, realLights[i], leftScratch[i]);
        setLight(PER + i, realLights[PER + i], rightScratch[i]);
      }
    },
  };
}
