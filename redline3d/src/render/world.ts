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
const PYLON_BASE_Y = 9;

function makeSun(): THREE.Group {
  const g = new THREE.Group();
  const colors = ["#ffe24a", "#ffd24a", "#ffb24a", "#ff8a4a", "#ff5a6a", "#ff3a8a", "#d83b6a"];
  for (let i = 0; i < colors.length; i++) {
    const w = 120 - i * 11;
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, 6), new THREE.MeshBasicMaterial({ color: colors[i], fog: false }));
    bar.position.set(0, 78 - i * 9, -780);
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

  // mountains
  const mtnMat = new THREE.MeshBasicMaterial({ color: "#2a0f3a", fog: false });
  for (let i = 0; i < 12; i++) {
    const h = 90 + Math.random() * 90;
    const r = 90 + Math.random() * 60;
    const c = new THREE.Mesh(new THREE.ConeGeometry(r, h, 4), mtnMat);
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

  // roadside pylons (the speed cue) — they ride the surface
  const SP = 44, COUNT = 22, TOTAL = SP * COUNT, RECYCLE = 26;
  const pyGeo = new THREE.BoxGeometry(0.9, 18, 0.9);
  const capGeo = new THREE.BoxGeometry(2.2, 1.4, 2.2);
  const matCyan = new THREE.MeshStandardMaterial({ color: "#06121a", emissive: "#27e7ff", emissiveIntensity: 1.6 });
  const matMag = new THREE.MeshStandardMaterial({ color: "#0a0612", emissive: "#ff39c0", emissiveIntensity: 1.6 });
  const pylons: THREE.Object3D[] = [];
  for (let i = 0; i < COUNT; i++) {
    for (const side of [-1, 1]) {
      const mat = side < 0 ? matCyan : matMag;
      const post = new THREE.Mesh(pyGeo, mat);
      const cap = new THREE.Mesh(capGeo, mat);
      cap.position.y = 9.5;
      const o = new THREE.Group();
      o.add(post, cap);
      o.position.set(side * 15.5, PYLON_BASE_Y, RECYCLE - i * SP);
      group.add(o);
      pylons.push(o);
    }
  }

  let scroll = 0, biasCur = 0;
  const surfaceY = (worldZ: number) => {
    const localY = -(worldZ + PLANE_Z);
    return Math.sin((localY + scroll) * FREQ) * AMP + biasCur;
  };

  return {
    group,
    surfaceY,
    update(dt, speed, bias) {
      const flow = speed * dt;
      scroll += flow;
      biasCur += (bias - biasCur) * 0.06;
      for (const mat of [gridMat, roadMat]) {
        mat.uniforms.uOffset.value += flow * 0.06;
        mat.uniforms.uScroll.value = scroll;
        mat.uniforms.uBias.value = biasCur;
      }
      for (const p of pylons) {
        p.position.z += flow;
        if (p.position.z > RECYCLE) p.position.z -= TOTAL;
        p.position.y = PYLON_BASE_Y + surfaceY(p.position.z);
      }
    },
  };
}
