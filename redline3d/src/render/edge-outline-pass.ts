import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { inkScale } from "./toon";
import { pNum, pBool } from "../config/visual-presets";

// Screen-space depth edge pass — the "full shader" toon look. After the beauty + bloom, it re-renders
// the scene's DEPTH into a private target (real materials, so vertex-displaced roads/grids and the
// wave keep their true silhouette; additive/glow layers use depthWrite:false so they never leave a
// depth footprint → never get inked), then a full-screen shader inks every depth discontinuity and
// reconstructed-normal crease in near-black. That draws a uniform ink line around EVERY silhouette —
// road, mountains, buildings, props, crates — without per-object geometry.
//
// Line weight tracks inkScale() (the outline dial), so [ ] / __outline scales the world ink together
// with the car hull outlines. CARS are excluded from the depth prepass (their groups are hidden while
// it renders) so their thick inverted-hull outlines aren't double-lined by a thin screen edge.
//
// Toggle-safe: the composer skips this pass when `enabled` is false — classic style, or the
// `toon.edgePass` kill-switch (default ON; meant to be turned off on weak GPUs like Seeker).

const EDGE_FLAG_KEY = "toon.edgePass";
/** localStorage kill-switch; default is the config file's Global.edgePass (ON). A localStorage value
 *  (dev sandbox) overrides it; disable to drop the full-res depth prepass (e.g. Seeker). */
export function edgePassEnabled(): boolean {
  const def = pBool("Global", "edgePass", true);
  try { const raw = localStorage.getItem(EDGE_FLAG_KEY); return raw == null ? def : raw !== "false"; } catch { return def; }
}
export function setEdgePassEnabled(on: boolean): void {
  try { localStorage.setItem(EDGE_FLAG_KEY, String(on)); } catch { /* private mode */ }
}

const INK = new THREE.Color(0x0a0a12); // near-black ink (matches the toon hull outline colour)

export interface EdgeOpts {
  /** base line half-width in pixels at inkScale 1.0 (scaled live by the outline dial) */
  thickness?: number;
  /** depth-silhouette sensitivity (lower = more lines); scaled up with distance internally */
  depthThreshold?: number;
  /** reconstructed-normal crease sensitivity in [0..2] (lower = more crease lines) */
  normalThreshold?: number;
  /** ink opacity 0..1 */
  opacity?: number;
}

export class EdgeOutlinePass extends Pass {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private depthTarget: THREE.WebGLRenderTarget;
  private fsQuad: FullScreenQuad;
  private material: THREE.ShaderMaterial;
  private baseThickness: number;
  /** roots hidden while the depth prepass renders → excluded from edges (the car groups) */
  exclude: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera, opts: EdgeOpts = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.baseThickness = opts.thickness ?? pNum("Global", "edgeThickness", 1.3);

    const size = new THREE.Vector2(1, 1);
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture,
      depthBuffer: true,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });

    const cam = camera as THREE.PerspectiveCamera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: depthTexture },
        resolution: { value: size },
        cameraNear: { value: cam.near ?? 0.1 },
        cameraFar: { value: cam.far ?? 2000 },
        uThickness: { value: this.baseThickness },
        uColor: { value: INK.clone() },
        uDepthThresh: { value: opts.depthThreshold ?? pNum("Global", "edgeDepth", 0.28) },
        uNormalThresh: { value: opts.normalThreshold ?? pNum("Global", "edgeNormal", 0.55) },
        uOpacity: { value: opts.opacity ?? 1.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */`
        #include <packing>
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2 resolution;
        uniform float cameraNear;
        uniform float cameraFar;
        uniform float uThickness;
        uniform vec3 uColor;
        uniform float uDepthThresh;
        uniform float uNormalThresh;
        uniform float uOpacity;

        // linear view-space distance (positive), so thresholds behave uniformly across the frustum
        float linDepth(vec2 uv){
          float d = texture2D(tDepth, uv).x;
          return -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
        }
        // crude view-space position for normal reconstruction (fov factor cancels in the cross product)
        vec3 viewPos(vec2 uv, float z){ return vec3((uv * 2.0 - 1.0) * z, z); }

        void main(){
          vec3 base = texture2D(tDiffuse, vUv).rgb;
          vec2 texel = uThickness / resolution;

          float zC = linDepth(vUv);
          float zE = linDepth(vUv + vec2(texel.x, 0.0));
          float zW = linDepth(vUv - vec2(texel.x, 0.0));
          float zN = linDepth(vUv + vec2(0.0, texel.y));
          float zS = linDepth(vUv - vec2(0.0, texel.y));

          // depth silhouette: summed neighbour gap, tolerance grows with distance so the far ground
          // plane and the horizon don't shimmer into a line.
          float dh = abs(zE - zC) + abs(zW - zC) + abs(zN - zC) + abs(zS - zC);
          float depthEdge = step(uDepthThresh * (1.0 + zC * 0.6), dh);

          // crease from reconstructed neighbour normals (catches coplanar-depth orientation changes)
          vec3 pC = viewPos(vUv, zC);
          vec3 nA = normalize(cross(viewPos(vUv + vec2(texel.x,0.0), zE) - pC, viewPos(vUv + vec2(0.0,texel.y), zN) - pC));
          vec3 nB = normalize(cross(pC - viewPos(vUv - vec2(texel.x,0.0), zW), pC - viewPos(vUv - vec2(0.0,texel.y), zS)));
          float normalEdge = step(uNormalThresh, 1.0 - clamp(dot(nA, nB), -1.0, 1.0));

          float edge = clamp(max(depthEdge, normalEdge), 0.0, 1.0) * uOpacity;
          gl_FragColor = vec4(mix(base, uColor, edge), 1.0);
        }
      `,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.depthTarget.setSize(width, height);
    this.material.uniforms.resolution.value.set(width, height);
  }

  // ── DEV Light-Lab tuning accessors ──
  get depthThreshold(): number { return this.material.uniforms.uDepthThresh.value; }
  set depthThreshold(v: number) { this.material.uniforms.uDepthThresh.value = v; }
  get normalThreshold(): number { return this.material.uniforms.uNormalThresh.value; }
  set normalThreshold(v: number) { this.material.uniforms.uNormalThresh.value = v; }
  get thickness(): number { return this.baseThickness; }
  set thickness(v: number) { this.baseThickness = v; }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    // ── depth prepass: real materials (keeps vertex-displaced roads/grid true; glow = depthWrite:false
    //    so it never writes depth), cars hidden so their hull outlines aren't double-lined ──
    const hidden: THREE.Object3D[] = [];
    for (const root of this.exclude) { if (root.visible) { root.visible = false; hidden.push(root); } }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;

    for (const root of hidden) root.visible = true;

    // live line weight from the shared outline dial
    this.material.uniforms.uThickness.value = Math.max(0.75, this.baseThickness * (inkScale() / 0.7));
    this.material.uniforms.tDiffuse.value = readBuffer.texture;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.depthTarget.depthTexture?.dispose();
    this.depthTarget.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
