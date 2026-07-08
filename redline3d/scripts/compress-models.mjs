// compress-models.mjs — shrink car GLBs to mobile budgets (the crash fix).
//
//   node scripts/compress-models.mjs                    # all models, in place
//   node scripts/compress-models.mjs --model skull      # one model (after a wheels:fix re-rig)
//   node scripts/compress-models.mjs --out /tmp/x       # write elsewhere (QA before swap)
//
// Per model: resize textures (max 1024; 512 when the model carries >8 maps) →
// weld → simplify (ratio 0.5, error 0.1%). Output stays a plain GLB — no loader
// changes, and the wheel_N rig nodes + perpsWheel extras survive untouched.
//
// WHY: desktop-grade PBR sets decode to ~90-250MB of GPU memory PER CAR on mobile
// (2048/4096 maps × RGBA × mipmaps); the lobby loads 6 cars and the garage 13,
// which is what was killing Chrome/Safari tabs on phones. After this pass a car
// costs ~25-35MB decoded.
//
// PIPELINE NOTE: scripts/fix-wheels.mjs restores the PRISTINE (uncompressed) GLB
// from git before re-rigging — so after any wheels:fix run, re-run this script
// for that model or its GLB reverts to the fat original.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(SCRIPTS, "../public/models");

// already tiny — compressing buys nothing and risks their hand-tuned look
const SKIP = new Set(["cybertruck", "vaporwave"]);
// wheel QA (_wheelqa --assert) fails on these when decimated — thin tread bands lose
// verts / pivots drift past the 2% gate. They get resize+weld only (textures are the
// dominant memory cost anyway); the heavy-geometry models all pass QA with simplify.
const NO_SIMPLIFY = new Set(["delorean", "flintstone", "helmet", "kraken", "magnet", "orion", "pink-rod", "ramen", "six-wheeler"]);
const SIMPLIFY_RATIO = "0.5";
const SIMPLIFY_ERROR = "0.001";

const args = process.argv.slice(2);
const argOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const only = argOf("--model");
const outDir = argOf("--out") ?? MODELS_DIR;
mkdirSync(outDir, { recursive: true });

const models = (only ? [`${only}.glb`] : readdirSync(MODELS_DIR).filter((f) => f.endsWith(".glb")))
  .filter((f) => only || !SKIP.has(f.replace(".glb", "")));

const mb = (p) => statSync(p).size / 1e6;
const cli = (cmd, ...rest) => {
  const r = spawnSync("npx", ["--yes", "@gltf-transform/cli", cmd, ...rest], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`gltf-transform ${cmd} failed:\n${r.stderr}`);
};

const io = new NodeIO();
const t0 = Date.now();
for (const f of models) {
  const src = join(MODELS_DIR, f);
  const before = mb(src);

  // texture-heavy interiors (20+ maps) get a tighter cap — total decoded budget, not per-map size
  const texCount = (await io.read(src)).getRoot().listTextures().length;
  const cap = texCount > 8 ? "512" : "1024";

  const tmp = mkdtempSync(join(tmpdir(), "glbc-"));
  const a = join(tmp, "a.glb"), b = join(tmp, "b.glb"), c = join(tmp, "c.glb");
  const simplify = !NO_SIMPLIFY.has(f.replace(".glb", ""));
  cli("resize", src, a, "--width", cap, "--height", cap);
  cli("weld", a, b);
  if (simplify) cli("simplify", b, c, "--ratio", SIMPLIFY_RATIO, "--error", SIMPLIFY_ERROR);
  copyFileSync(simplify ? c : b, join(outDir, f));
  rmSync(tmp, { recursive: true, force: true });

  console.log(`${f.padEnd(20)} ${before.toFixed(1).padStart(6)}MB → ${mb(join(outDir, f)).toFixed(1).padStart(5)}MB  (tex ${texCount} @ ≤${cap}${simplify ? "" : ", no-simplify"})`);
}
console.log(`\ndone: ${models.length} models in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${outDir}`);
