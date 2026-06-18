import * as THREE from "three";

export interface World {
  group: THREE.Group;
  update(dt: number, speed: number): void;
}

function makeSun(): THREE.Group {
  const g = new THREE.Group();
  const colors = ["#ffe24a", "#ffd24a", "#ffb24a", "#ff8a4a", "#ff5a6a", "#ff3a8a", "#d83b6a"];
  for (let i = 0; i < colors.length; i++) {
    const w = 60 - i * 6;
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(w, 3.4),
      new THREE.MeshBasicMaterial({ color: colors[i], fog: false })
    );
    bar.position.set(0, 44 - i * 5, -600);
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
      float line(float x){ float g = abs(fract(x)-0.5); return smoothstep(0.48,0.5,1.0-g*2.0); }
      void main(){
        float gx = line(vUv.x*40.0);
        float gz = line(vUv.y*120.0 + uOffset);
        float g = max(gx, gz);
        vec3 c = mix(uColor2, uColor, vUv.x);
        float fade = smoothstep(0.0, 0.35, vUv.y);
        gl_FragColor = vec4(c, g * fade * 0.9);
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
        float dash = step(0.5, fract(vUv.y*60.0 + uOffset)) * step(0.46,vUv.x)*step(vUv.x,0.54);
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

  return {
    group,
    update(dt, speed) {
      gridMat.uniforms.uOffset.value += dt * speed * 0.02;
      roadMat.uniforms.uOffset.value += dt * speed * 0.02;
    },
  };
}
