// fix-wheels.mjs — the fast loop for hand-fixing a car's wheels (~2s end to end).
//
// Draw circles in wheel-marker.html, press "copy JSON", then:
//
//   npm run wheels:fix -- --json '<paste>'      # upsert circles + restore + rig + QA
//   pbpaste | npm run wheels:fix -- --stdin     # same, straight from the clipboard
//   npm run wheels:fix -- skull                 # re-run for a model already in wheel-overrides.json
//
// What it does, in order:
//   1. (--json/--stdin) upsert the pasted circles into scripts/wheel-overrides.json
//   2. restore the PRISTINE pre-rig GLB from git (scripts/wheel-pristine.json blob) —
//      rig-wheels must never run on an already-rigged model (double-cut)
//   3. rig-wheels --model <m>  (picks up the overrides automatically)
//   4. rig-wheels --verify --model <m>  (wheel_N contract + expected count)
//   5. _wheelqa.mjs --assert  (pivot offset, tread coverage, roundness — hard gates)
//
// NOT run here (do these when it matters, not per-iteration):
//   - npm run bake:cards  — a wheel re-cut does not change card pixels; bake when a
//     model is added or visually retuned
//   - the browser spin eyeball — open /wheel-marker.html and tick "spin test" for
//     the final feel check before committing
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(SCRIPTS, "../public/models");
const OVERRIDES = resolve(SCRIPTS, "wheel-overrides.json");
const PRISTINE = resolve(SCRIPTS, "wheel-pristine.json");

const t0 = Date.now();
const step = (label) => console.log(`\n▶ ${label}  [t+${((Date.now() - t0) / 1000).toFixed(1)}s]`);
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

// ---------- parse input ----------
const args = process.argv.slice(2);
let model = args.find((a) => !a.startsWith("--"));
let pasted = null;
if (args.includes("--json")) pasted = args[args.indexOf("--json") + 1];
if (args.includes("--stdin")) pasted = readFileSync(0, "utf8");
if (pasted) {
  let spec;
  try { spec = JSON.parse(pasted); } catch (e) { die(`--json is not valid JSON: ${e.message}`); }
  if (!spec.model || !Array.isArray(spec.circles) || !spec.circles.length)
    die(`pasted JSON needs { model, circles[] } — got keys [${Object.keys(spec)}]`);
  for (const [i, c] of spec.circles.entries())
    if (!Number.isFinite(c.x ?? c.z) || !Number.isFinite(c.y) || !(c.r > 0))
      die(`circle ${i} is malformed: ${JSON.stringify(c)}`);
  model = spec.model;
  const overrides = JSON.parse(readFileSync(OVERRIDES, "utf8"));
  const { model: _m, ...entry } = spec;
  overrides[model] = entry;
  writeFileSync(OVERRIDES, JSON.stringify(overrides, null, 2) + "\n");
  step(`upserted ${spec.circles.length} circles for "${model}" into wheel-overrides.json`);
} else if (!model) {
  die("usage: fix-wheels.mjs <model> | --json '<wheel-marker JSON>' | --stdin");
}

// ---------- restore pristine ----------
const pristine = JSON.parse(readFileSync(PRISTINE, "utf8"));
const blob = pristine.blobs[model];
if (!blob) die(`no pristine blob for "${model}" in wheel-pristine.json — add one (see _comment)`);
step(`restoring pristine ${model}.glb from git blob ${blob.slice(0, 12)}…`);
const glb = execFileSync("git", ["cat-file", "blob", blob], { maxBuffer: 1024 * 1024 * 1024 });
// the glTF JSON chunk (node names included) sits at the head of the GLB — a
// pristine model must not already carry the rig contract
if (glb.subarray(0, 4 * 1024 * 1024).includes('"wheel_0"'))
  die(`pristine blob for "${model}" already contains wheel_0 — manifest points at a rigged version`);
writeFileSync(resolve(MODELS_DIR, `${model}.glb`), glb);

// ---------- rig + verify + QA ----------
const run = (label, cmd, cmdArgs) => {
  step(label);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: resolve(SCRIPTS, "..") });
  if (r.status !== 0) die(`${label} failed — model left in restored-pristine state, fix and re-run`);
};
run(`rig ${model} from manual circles`, "node", ["scripts/rig-wheels.mjs", "--model", model]);
run("verify wheel contract", "node", ["scripts/rig-wheels.mjs", "--verify", "--model", model]);
run("wheel QA gates", "node", ["scripts/_wheelqa.mjs", `public/models/${model}.glb`, "--assert"]);

console.log(`\n✔ ${model}.glb rebaked + QA-clean in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("  eyeball the spin before committing: /wheel-marker.html → pick the model → tick spin test");
