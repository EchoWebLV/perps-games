import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { EdgeOutlinePass } from "./edge-outline-pass";

export interface Post {
  render(): void;
  setSize(w: number, h: number): void;
  /** the toon depth-edge pass (last in the chain). App wires `.exclude` (car groups) + `.enabled`. */
  edge: EdgeOutlinePass;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, bloomScale = 1, samples = 4): Post {
  const composer = new EffectComposer(renderer);
  // The composer renders into its own targets and bypasses the renderer's MSAA. Multisampling
  // those targets anti-aliases the scene before the bloom threshold: the low tier uses 2x and
  // the high tier uses 4x pre-bloom multisampling.
  composer.renderTarget1.samples = samples;
  composer.renderTarget2.samples = samples;
  composer.addPass(new RenderPass(scene, camera));
  // The scene renders at full resolution; the bloom blur chain is scaled by bloomScale —
  // 1 on the high tier (devices that earn it match desktop exactly), 0.5 on the low tier
  // (same glow, ~¼ the blurred fragments — the Mali-class win; see platform/perf.ts).
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth * bloomScale, window.innerHeight * bloomScale), 0.9, 0.6, 0.85);
  composer.addPass(bloom);
  // toon depth-edge pass AFTER bloom → crisp ink over the bloomed beauty. Disabled by default; the
  // app enables it (toon style + kill-switch) and fills its car-exclusion list. When disabled the
  // composer routes bloom straight to screen (three ≥0.169 isLastEnabledPass), so it's a clean bypass.
  const edge = new EdgeOutlinePass(scene, camera);
  edge.setSize(window.innerWidth, window.innerHeight);
  edge.enabled = false;
  composer.addPass(edge);
  return {
    render: () => composer.render(),
    setSize: (w, h) => { composer.setSize(w, h); bloom.setSize(w * bloomScale, h * bloomScale); edge.setSize(w, h); },
    edge,
  };
}
