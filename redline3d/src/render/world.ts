import * as THREE from "three";

export interface World {
  group: THREE.Group;
  /** speed is in world units/sec (from the chase camera) */
  update(dt: number, speed: number): void;
}

function makeSun(): THREE.Group {
  const g = new THREE.Group();
  const colors = ["#ffe24a", "#ffd24a", "#ffb24a", "#ff8a4a", "#ff5a6a", "#ff3a8a", "#d83b6a"];
  for (let i = 0; i < colors.length; i++) {
    const w = 120 - i * 11;
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(w, 6),
      new THREE.MeshBasicMaterial({ color: colors[i], fog: false })
    );
    bar.position.set(0, 78 - i * 9, -780);
    g.add(bar);
  }
  return g;
}

export function createWorld(): World {
  const group = new THREE.Group();

  // gradient sky dome (vertex-painted)
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      fog: false,
      uniforms: { top: { value: new THREE.Color("#160a2e") }, bot: { value: new THREE.Color("#7a1d5e") } },
      vertexShader: `varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
      fragmentShader: `varying float h; uniform vec3 top; uniform vec3 bot; void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*1.4+0.3,0.0,1.0)), 1.0);} `,
    })
  );
  group.add(sky);
  group.add(makeSun());

  // neon grid floor — a large plane with a scrolling grid shader
  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uColor: { value: new THREE.Color("#ff39c0") }, uColor2: { value: new THREE.Color("#27e7ff") } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
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
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(800, 2000, 1, 1), gridMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -900);
  group.add(floor);

  // road: a dark reflective strip down the middle with emissive neon edges
  const roadMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uEdge: { value: new THREE.Color("#ff39c0") } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
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
  const road = new THREE.Mesh(new THREE.PlaneGeometry(26, 2000, 1, 1), roadMat);
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.02, -900);
  group.add(road);

  // ── roadside pylons: the dominant speed cue — they rush past the camera ──
  const SP = 44;          // spacing along the road
  const COUNT = 22;       // pylons per side
  const TOTAL = SP * COUNT;
  const RECYCLE = 26;     // z past which a pylon wraps back to the far end
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
      o.position.set(side * 15.5, 9, RECYCLE - i * SP);
      group.add(o);
      pylons.push(o);
    }
  }

  return {
    group,
    update(dt, speed) {
      const flow = speed * dt;
      gridMat.uniforms.uOffset.value += flow * 0.06;
      roadMat.uniforms.uOffset.value += flow * 0.06;
      for (const p of pylons) {
        p.position.z += flow;
        if (p.position.z > RECYCLE) p.position.z -= TOTAL;
      }
    },
  };
}
