// Light Lab — a DEV-only lil-gui tuning panel for choosing the lighting/look of each world. Scenes
// register their live tweakables when built via registerLightLab(name, spec); the panel shows a folder
// per registered scene plus a Global folder (engine knobs). Every change is bound to the live object
// (applies instantly), saved to localStorage `lightlab.<scene>`, and re-applied on boot IN DEV ONLY
// (registerLightLab is a no-op in production). Each folder has COPY PRESET (dumps the current JSON to
// the clipboard so we can bake it as a shipped default) and RESET (clears the override → shipped values).
//
// Activation (DEV only): key L toggles the panel, or ?lightlab=1 opens it on load.
//
// lil-gui ships with three (examples/jsm/libs) — no new dependency. It's dynamically imported inside
// openPanel() so it lands in a lazy chunk that production (where the panel never opens) never loads.

import { PRESETS } from "../config/visual-presets";

/** one tweakable bound to a live object. `get` seeds the control; `set` applies to the live object. */
export type LabControl =
  | { key: string; label?: string; kind: "num"; min: number; max: number; step?: number; get: () => number; set: (v: number) => void }
  | { key: string; label?: string; kind: "color"; get: () => string; set: (v: string) => void } // color as "#rrggbb"
  | { key: string; label?: string; kind: "bool"; get: () => boolean; set: (v: boolean) => void };

export interface LabScene { title?: string; controls: LabControl[] }
type LabValue = number | boolean | string;

const DEV = !!import.meta.env.DEV;
const scenes = new Map<string, LabScene>();
const defaults = new Map<string, Record<string, LabValue>>(); // shipped values captured before any override
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gui: any = null;
const folders = new Set<string>();

const storeKey = (name: string): string => `lightlab.${name}`;
function loadSaved(name: string): Record<string, LabValue> | null {
  try { const r = localStorage.getItem(storeKey(name)); return r ? JSON.parse(r) : null; } catch { return null; }
}
function persist(name: string, params: Record<string, LabValue>): void {
  try { localStorage.setItem(storeKey(name), JSON.stringify(params)); } catch { /* private mode */ }
}

/** Register a scene's live tweakables. DEV-only: in production this is a no-op (no override, no panel).
 *  Captures the shipped defaults, re-applies any saved override immediately (boot re-apply), and — if
 *  the panel is already open — adds the folder live. */
export function registerLightLab(name: string, scene: LabScene): void {
  if (!DEV) return;
  scenes.set(name, scene);
  const def: Record<string, LabValue> = {};
  for (const c of scene.controls) def[c.key] = c.get();
  defaults.set(name, def);
  const saved = loadSaved(name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (saved) for (const c of scene.controls) { const v = saved[c.key]; if (v !== undefined) (c.set as (x: any) => void)(v); }
  if (gui) addFolder(name, scene);
  console.info(`[lightlab] registered "${name}" (${scene.controls.length} controls)${saved ? " + applied saved override" : ""}`);
}

function addFolder(name: string, scene: LabScene): void {
  if (folders.has(name)) return;
  folders.add(name);
  const f = gui.addFolder(scene.title ?? name);
  const params: Record<string, LabValue> = {};
  const saved = loadSaved(name) ?? {};
  for (const c of scene.controls) {
    params[c.key] = saved[c.key] !== undefined ? saved[c.key] : c.get();
    const ctrl = c.kind === "color" ? f.addColor(params, c.key)
      : c.kind === "bool" ? f.add(params, c.key)
      : f.add(params, c.key, c.min, c.max, c.step ?? 0.01);
    ctrl.name(c.label ?? c.key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl.onChange((v: any) => { (c.set as (x: any) => void)(v); persist(name, params); });
  }
  const actions = {
    "COPY PRESET": () => {
      const json = JSON.stringify(params, null, 2);
      navigator.clipboard?.writeText(json).catch(() => { /* clipboard blocked — log below still gives it */ });
      console.info(`[lightlab] "${name}" preset (also copied to clipboard):\n${json}`);
    },
    "RESET": () => {
      const def = defaults.get(name) ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const c of scene.controls) { const d = def[c.key]; if (d !== undefined) { (c.set as (x: any) => void)(d); params[c.key] = d; } }
      try { localStorage.removeItem(storeKey(name)); } catch { /* ignore */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.controllers.forEach((ct: any) => ct.updateDisplay());
      console.info(`[lightlab] reset "${name}" to shipped defaults`);
    },
  };
  f.add(actions, "COPY PRESET");
  f.add(actions, "RESET");
}

// ── SAVE ALL / COPY ALL: assemble the COMPLETE preset set — start from the file (so scenes not
// visited this session keep their saved values) and overlay every registered scene's current live
// state on top. SAVE posts it to the dev-only /__lightlab/save endpoint (writes the repo file);
// COPY drops the same JSON on the clipboard (the anywhere/prod fallback). ──
function collectAll(): Record<string, Record<string, LabValue>> {
  const out: Record<string, Record<string, LabValue>> = JSON.parse(JSON.stringify(PRESETS)); // file base (unvisited scenes)
  for (const [name, scene] of scenes) {
    const live: Record<string, LabValue> = { ...(out[name] ?? {}) };
    for (const c of scene.controls) live[c.key] = c.get();
    out[name] = live;
  }
  return out;
}
function toast(msg: string, ok = true): void {
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = [
    "position:fixed", "left:50%", "bottom:26px", "transform:translateX(-50%)", "z-index:2147483647",
    "padding:9px 16px", "border-radius:8px", "pointer-events:none", "font:700 13px/1 'Chakra Petch',ui-monospace,monospace",
    "letter-spacing:.04em", "color:#eaf2ff", `background:${ok ? "rgba(16,90,50,.94)" : "rgba(120,30,40,.94)"}`,
    "border:1px solid rgba(255,255,255,.25)", "box-shadow:0 6px 20px rgba(0,0,0,.5)",
  ].join(";");
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function clearAllOverrides(): void {
  try { for (const name of scenes.keys()) localStorage.removeItem(storeKey(name)); } catch { /* ignore */ }
}
async function copyAll(): Promise<void> {
  const json = JSON.stringify(collectAll(), null, 2);
  try { await navigator.clipboard?.writeText(json); toast("all presets copied to clipboard ✓"); }
  catch { toast("clipboard blocked — JSON logged to console", false); }
  console.info(`[lightlab] COPY ALL:\n${json}`);
}
async function saveAll(): Promise<void> {
  const payload = collectAll();
  try {
    const res = await fetch("/__lightlab/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    clearAllOverrides(); // the file is the truth now — drop sandbox overrides so they can't diverge
    toast("saved to repo ✓  (git diff visual-presets.json)");
    console.info("[lightlab] SAVE ALL → src/config/visual-presets.json written; localStorage overrides cleared");
  } catch (e) {
    console.warn("[lightlab] SAVE ALL failed (prod/static host?) — copying to clipboard instead:", e);
    await copyAll();
    toast("save endpoint unavailable — copied JSON to clipboard", false);
  }
}

let _opening = false;
async function openPanel(): Promise<void> {
  if (gui) { (gui.domElement as HTMLElement).style.display = ""; return; }
  if (_opening) return; _opening = true;
  const GUI = (await import("three/examples/jsm/libs/lil-gui.module.min.js")).default;
  _opening = false;
  if (gui) return; // opened concurrently
  gui = new GUI({ title: "LIGHT LAB", width: 300 });
  const el = gui.domElement as HTMLElement;
  el.style.position = "fixed"; el.style.top = "8px"; el.style.right = "8px"; el.style.zIndex = "2147483646";
  // prominent top actions — persist EVERYTHING at once
  const top = { "★ SAVE ALL → repo": () => void saveAll(), "COPY ALL": () => void copyAll() };
  gui.add(top, "★ SAVE ALL → repo");
  gui.add(top, "COPY ALL");
  for (const [name, scene] of scenes) addFolder(name, scene);
  console.info(`[lightlab] open — scenes: ${[...scenes.keys()].join(", ") || "(none yet)"}`);
}
function closePanel(): void { if (gui) (gui.domElement as HTMLElement).style.display = "none"; }
function togglePanel(): void {
  if (!gui || (gui.domElement as HTMLElement).style.display === "none") void openPanel(); else closePanel();
}

// DEV activation: key L toggles, ?lightlab=1 opens on load. Registrations may arrive after this module
// loads; openPanel() folders whatever is registered, and later registrations fold themselves in.
if (DEV && typeof window !== "undefined") {
  const isTyping = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
  };
  addEventListener("keydown", (e) => { if ((e.key === "l" || e.key === "L") && !isTyping(e)) togglePanel(); });
  if (new URLSearchParams(location.search).has("lightlab")) requestAnimationFrame(() => void openPanel());
}
