// ALL-CARS ability house-economics sim — paired replay of every money-mechanic
// ability against a SHARED baseline round on identical price windows.
//
// Same faithfulness contract as swerve-sim.ts: production equityOf / payoutOf /
// bufferOf / rebank imported directly from packages/engine; per-tick precedence
// liq -> cap -> ability -> time, terminal-first exactly like the on-chain tick.
//
// Ability arms (money mechanics only — Vaporwave/Cart Rod/Slot Machine are
// coins-economy, Starter is stock = the baseline; Cybertruck = the 1500x lev row):
//   skull     2s on-chain liq grace: first sub-floor tick stamps a breach; only a
//             tick >=2s later STILL under the floor liquidates; recovery clears.
//             (re-armable per program today: every recovery re-earns a fresh grace)
//   skull1    proposed fix: same grace but ONCE per round — the first survived
//             breach consumes it; the next breach liquidates instantly.
//   airbag    Flintstone: a liq pays min(0.20, wreck equity) * (1-EDGE) instead of 0.
//   swerve    Helmet: once/round at buffer<=0.10, stop-and-reverse (rerun for comparability).
//   pinkSL    Pink Rod SL=0.5 (TP off): crank cash-out at eq<=0.5 (liq checked first).
//   pinkTP    Pink Rod TP=2.0 (SL off): crank cash-out at eq>=2.0.
//   pinkBoth  Pink Rod SL=0.5 + TP=2.0.
//   flux15    DeLorean policy bot: at eq>=1.5 bank + pin lev 10 for 4s, 8s cooldown, re-fireable.
//   flux20    same, fires at eq>=2.0.
//   nitro     Orion policy bot: whenever ready, lev = min(2*base, 3000) for 3s, 6s cooldown.
//   flipper   Clown Car chaos bot: random flip ~1/20s (neutrality control).
//   heavy     Six Wheeler: 90s round instead of 60s (same lev; bet-size scales exposure, not EV%).
//
// Run: node sim/abilities-sim.ts   (env: SPIKE_SEQS, DRIFT_SEQS, STRIDE_REAL)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equityOf, payoutOf, bufferOf, rebank } from "../packages/engine/src/economics.ts";
import { buildSpike, buildDriftless, rng } from "./paths.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "data");
const EDGE = 0.05, CAP = 25, MAXSEC = 60, HEAVY_SEC = 90, WINDOW = HEAVY_SEC + 1;
const SWERVE_BUFFER = 0.10, GRACE_SECS = 2, AIRBAG = 0.20, FLUX_LEV = 10, FLUX_ACTIVE = 4, FLUX_COOLDOWN = 8;
const NITRO_ACTIVE = 3, NITRO_COOLDOWN = 6, FLIP_P = 1 / 20;
const LEVS = [50, 200, 500, 1000, 1500, 2000, 3000]; // 1500 = the Cybertruck base
const FLOORS = [0.10, 0.20];
const SPIKE_SEQS = Number(process.env.SPIKE_SEQS ?? 400);
const DRIFT_SEQS = Number(process.env.DRIFT_SEQS ?? 200);
const STRIDE_REAL = Number(process.env.STRIDE_REAL ?? 1);

type Pos = { banked: number; dir: 1 | -1; lev: number; entryRaw: number };
type Outcome = "liq" | "cap" | "time" | "exit"; // exit = SL/TP crank cash-out
interface Res { outcome: Outcome; mult: number; fired: number }

const ARMS = ["skull", "skull1", "skull1s", "skullCashV1", "skullCashV2", "skullCashCap", "skullMini", "skullMiniHalf", "skullRebuy", "skullRevive", "skullRide", "skullRide2", "skullR50", "skullR150", "skullR400", "skullGate", "airbag", "swerve", "pinkSL", "pinkTP", "pinkBoth", "flux15", "flux20", "nitro", "flipper", "heavy"] as const;
type Arm = (typeof ARMS)[number] | "base";

function runRound(prices: number[], start: number, dir: 1 | -1, lev: number, LIQ: number, arm: Arm, seed: number): Res {
  let pos: Pos = { banked: 0, dir, lev, entryRaw: prices[start] };
  const maxSec = arm === "heavy" ? HEAVY_SEC : MAXSEC;
  let fired = 0;
  // per-arm state
  let breachT: number | null = null;                    // skull / skull1
  let graceUsed = false;                                // skull1: one survived breach consumes it
  let fluxUntil = 0, fluxReadyAt = 0;                   // flux: active-until / next-ready tick
  let nitroUntil = 0, nitroReadyAt = 1;                 // nitro
  const r = arm === "flipper" ? rng(seed) : null;       // flipper determinism
  let rideTp = 0;                                       // skullRide: Death's cut after a revive
  let rebuyAnchor = false;                              // skullRebuy: mini bet live (half stake, net-accounted)
  const sl = arm === "pinkSL" || arm === "pinkBoth" ? 0.5 : 0;
  const tp = arm === "pinkTP" || arm === "pinkBoth" ? 2.0 : 0;
  const fluxAt = arm === "flux15" ? 1.5 : arm === "flux20" ? 2.0 : 0;

  for (let t = 1; t <= maxSec; t++) {
    const p = prices[start + t];
    const eq = equityOf(pos, p);

    // Death's-Door cash-out window: 2s after the first breach the round settles at the mark.
    if ((arm === "skullCashV1" || arm === "skullCashV2" || arm === "skullCashCap") && breachT !== null && t - breachT >= GRACE_SECS) {
      if (arm === "skullCashV2" && eq <= LIQ) return { outcome: "liq", mult: 0, fired: 1 };
      return { outcome: "exit", mult: payoutOf(1, arm === "skullCashCap" ? Math.min(eq, 0.5) : eq, EDGE), fired: 1 };
    }

    // -- terminal-first: liquidation (with the Skull's grace / Flintstone's airbag) --
    if (eq <= LIQ) {
      if (arm.startsWith("skullR") && arm !== "skullRevive" && arm !== "skullRebuy" && !graceUsed) {
        const rlev = arm === "skullR50" ? 50 : arm === "skullR150" ? 150 : arm === "skullR400" ? 400 : lev;
        pos = { banked: LIQ - 1, dir: pos.dir, lev: Math.min(rlev, lev), entryRaw: p };
        graceUsed = true; fired = 1; rideTp = 0.5;
        if (t === maxSec) return { outcome: "time", mult: payoutOf(1, LIQ, EDGE), fired };
        continue;
      }
      if (false) { const _unused = 0;
        // Devil's Bargain: revive AT the floor at FULL leverage — the comeback run
        // auto-cashes at x0.5 (Death's cut). Both exits absorb → E[give] ~ floor residue.
        pos = { banked: LIQ - 1, dir: pos.dir, lev, entryRaw: p };
        graceUsed = true; fired = 1; rideTp = 0.5;
        if (t === maxSec) return { outcome: "time", mult: payoutOf(1, LIQ, EDGE), fired };
        continue;
      }
      if (arm === "skullRevive" && !graceUsed) {
        // Second Wind: revive AT the floor, leverage pinned to RMIN for the rest of the round.
        // Give is bounded at the floor residue and vol-insensitive (the stub barely moves at 10x).
        pos = { banked: LIQ - 1, dir: pos.dir, lev: 10, entryRaw: p };
        graceUsed = true; fired = 1;
        if (t === maxSec) return { outcome: "time", mult: payoutOf(1, LIQ, EDGE), fired };
        continue;
      }
      if ((arm === "skullCashV1" || arm === "skullCashV2" || arm === "skullCashCap") && (breachT === null || t - breachT < GRACE_SECS)) {
        if (breachT === null) breachT = t; // Death's Door, cash-out flavor: round ends 2s from the FIRST breach
        // true grace: NO death inside the window — the +2s mark settles it whatever happens
        if (t === maxSec) return { outcome: "exit", mult: payoutOf(1, arm === "skullCashCap" ? Math.min(eq, 0.5) : eq, EDGE), fired: 1 };
        continue;
      }
      if ((arm === "skullMini" || arm === "skullMiniHalf" || arm === "skullRebuy") && !graceUsed) {
        // die-and-respawn family: the wreck is real, a mini car rides on at x0.5.
        // Mini/MiniHalf: the half is HOUSE-funded (liq pays half-as-live-position).
        // Rebuy: the half is PLAYER-funded (auto-rebuy: fresh half-stake position at x1,
        // shown as x0.5 of the original bet; accounted net of the extra stake).
        graceUsed = true; fired = 1;
        if (arm === "skullRebuy") { rebuyAnchor = true; pos = { banked: 0, dir: pos.dir, lev, entryRaw: p }; }
        else pos = { banked: -0.5, dir: pos.dir, lev: arm === "skullMiniHalf" ? Math.max(10, Math.round(lev / 2)) : lev, entryRaw: p };
        if (t === maxSec) return { outcome: "time", mult: arm === "skullRebuy" ? 0 : payoutOf(1, 0.5, EDGE), fired };
        continue;
      }
      if (arm === "skull1s" && !graceUsed) {
        // user proposal: survive liquidation once per round, 1s window = ONE extra tick
        if (breachT === null) breachT = t;
        else return { outcome: "liq", mult: 0, fired: fired || 1 }; // next tick still under → dead
        if (t === maxSec) return { outcome: "time", mult: payoutOf(1, eq, EDGE), fired };
        continue;
      }
      if (arm === "skull" || (arm === "skull1" && !graceUsed) || (arm === "skullGate" && lev <= 1000)) {
        if (breachT === null) breachT = t;                       // StampBreach
        else if (t - breachT >= GRACE_SECS) return { outcome: "liq", mult: 0, fired: fired || 1 }; // grace elapsed, still under
        // Hold: fall through alive (skip other triggers this tick — the program settles/holds and returns)
        if (t === maxSec) return { outcome: "time", mult: payoutOf(1, eq, EDGE), fired };
        continue;
      }
      if (arm === "airbag") return { outcome: "liq", mult: payoutOf(1, Math.min(AIRBAG, eq), EDGE), fired: 1 };
      return { outcome: "liq", mult: rebuyAnchor ? -0.5 : 0, fired };
    }
    if ((arm === "skull" || arm === "skull1" || arm === "skull1s" || arm === "skullGate") && breachT !== null) { breachT = null; fired++; graceUsed = true; } // ClearBreach — survived a floor touch

    if (eq >= CAP) return { outcome: "cap", mult: rebuyAnchor ? 0.5 * payoutOf(1, CAP, EDGE) - 0.5 : payoutOf(1, CAP, EDGE), fired };

    // -- ability triggers (post liq/cap, like the on-chain tick's precedence) --
    if (rideTp && eq >= rideTp) {
      // skullRide pays the observed mark (today's TP semantics — overshoots on jumps);
      // all other bargain variants clamp at the target: Death keeps everything above his half.
      return { outcome: "exit", mult: payoutOf(1, arm === "skullRide" ? eq : Math.min(eq, rideTp), EDGE), fired };
    }
    if (sl && eq <= sl) return { outcome: "exit", mult: payoutOf(1, eq, EDGE), fired: 1 };
    if (tp && eq >= tp) return { outcome: "exit", mult: payoutOf(1, eq, EDGE), fired: 1 };
    if (arm === "swerve" && !fired && bufferOf(eq, LIQ) <= SWERVE_BUFFER) {
      pos = { ...rebank(pos, p), dir: (pos.dir === 1 ? -1 : 1) as 1 | -1 };
      fired = 1;
    }
    if (fluxAt) {
      if (fluxUntil > 0 && t >= fluxUntil) { pos = { ...rebank(pos, p), lev }; fluxUntil = 0; } // freeze over → throttle lev back
      else if (fluxUntil === 0 && t >= fluxReadyAt && eq >= fluxAt) {
        pos = { ...rebank(pos, p), lev: FLUX_LEV };                                             // bank + pin to 10x
        fluxUntil = t + FLUX_ACTIVE; fluxReadyAt = t + FLUX_ACTIVE + FLUX_COOLDOWN; fired++;
      }
    }
    if (arm === "nitro" && lev * 2 > lev) {
      const boosted = Math.min(2 * lev, 3000);
      if (nitroUntil > 0 && t >= nitroUntil) { pos = { ...rebank(pos, p), lev }; nitroUntil = 0; }
      else if (nitroUntil === 0 && t >= nitroReadyAt && boosted !== lev) {
        pos = { ...rebank(pos, p), lev: boosted };
        nitroUntil = t + NITRO_ACTIVE; nitroReadyAt = t + NITRO_ACTIVE + NITRO_COOLDOWN; fired++;
      }
    }
    if (arm === "flipper" && r && r() < FLIP_P) { pos = { ...rebank(pos, p), dir: (pos.dir === 1 ? -1 : 1) as 1 | -1 }; fired++; }

    if (t === maxSec) return { outcome: "time", mult: rebuyAnchor ? 0.5 * payoutOf(1, eq, EDGE) - 0.5 : payoutOf(1, eq, EDGE), fired };
  }
  throw new Error("unreachable");
}

interface Cell {
  n: number; fired: number; sumMult: number; out: Record<Outcome, number>;
  sumD: number; blockMeans: number[]; blockSum: number; blockN: number;
  baseMult: number; // filled from the base cell at report time
}
const newCell = (): Cell => ({ n: 0, fired: 0, sumMult: 0, out: { liq: 0, cap: 0, time: 0, exit: 0 }, sumD: 0, blockMeans: [], blockSum: 0, blockN: 0, baseMult: 0 });
const BLOCK = 240;

const cells = new Map<string, Cell>();
const key = (m: string, arm: string, lev: number, liq: number) => `${m}|${arm}|${lev}|${liq}`;

function runMarket(market: string, priceSets: number[][], stride: number) {
  let seedBase = 777;
  for (const prices of priceSets) {
    const lastStart = prices.length - WINDOW;
    for (let start = 0; start <= lastStart; start += stride) {
      for (const dir of [1, -1] as const) {
        for (const lev of LEVS) for (const LIQ of FLOORS) {
          const b = runRound(prices, start, dir, lev, LIQ, "base", 0);
          const bk = key(market, "base", lev, LIQ);
          let bc = cells.get(bk); if (!bc) { bc = newCell(); cells.set(bk, bc); }
          bc.n++; bc.sumMult += b.mult; bc.out[b.outcome]++;
          for (const arm of ARMS) {
            const a = runRound(prices, start, dir, lev, LIQ, arm, seedBase + start * 7 + (dir === 1 ? 0 : 3));
            const k = key(market, arm, lev, LIQ);
            let c = cells.get(k); if (!c) { c = newCell(); cells.set(k, c); }
            c.n++; c.sumMult += a.mult; c.out[a.outcome]++; if (a.fired) c.fired++;
            const d = a.mult - b.mult;
            c.sumD += d;
            c.blockSum += d; if (++c.blockN === BLOCK) { c.blockMeans.push(c.blockSum / BLOCK); c.blockSum = 0; c.blockN = 0; }
          }
        }
      }
    }
    seedBase += 104729;
  }
}

const load = (f: string) => JSON.parse(readFileSync(join(DIR, `${f}.json`), "utf8")) as { meta: any; closes: number[] };
const t0 = Date.now();
const calm = load("calm"), fresh = load("fresh");
runMarket("calm", [calm.closes.filter((x: number) => x > 0)], STRIDE_REAL);
runMarket("fresh", [fresh.closes.filter((x: number) => x > 0)], STRIDE_REAL);
runMarket("spike", Array.from({ length: SPIKE_SEQS }, (_, i) => buildSpike(3660, 1000 + i).prices), 60);
runMarket("driftless", Array.from({ length: DRIFT_SEQS }, (_, i) => buildDriftless(3660, 4.19e-4, 5000 + i).prices), 60);

const rows: any[] = [];
for (const [k, c] of cells) {
  const [market, arm, lev, liq] = k.split("|");
  if (arm === "base") continue;
  const base = cells.get(key(market, "base", +lev, +liq))!;
  const meanB = base.sumMult / base.n, meanA = c.sumMult / c.n, dMean = c.sumD / c.n;
  let ci: number;
  if (c.blockMeans.length >= 8) {
    const bm = c.blockMeans, m = bm.reduce((a, b) => a + b, 0) / bm.length;
    const v = bm.reduce((a, b) => a + (b - m) * (b - m), 0) / (bm.length - 1);
    ci = 1.96 * Math.sqrt(v / bm.length);
  } else ci = NaN;
  rows.push({
    market, arm, lev: +lev, liq: +liq, n: c.n,
    fireRatePct: (100 * c.fired) / c.n,
    baseHouseEvPct: 100 * (1 - meanB),
    armHouseEvPct: 100 * (1 - meanA),
    houseDeltaPct: -100 * dMean, houseDeltaCi95: 100 * ci,
    outcomes: { liqPct: (100 * c.out.liq) / c.n, capPct: (100 * c.out.cap) / c.n, timePct: (100 * c.out.time) / c.n, exitPct: (100 * c.out.exit) / c.n },
    baseLiqPct: (100 * base.out.liq) / base.n,
  });
}

const out = {
  ranAt: new Date().toISOString(),
  config: { EDGE, CAP, MAXSEC, HEAVY_SEC, SWERVE_BUFFER, GRACE_SECS, AIRBAG, FLUX_LEV, FLUX_ACTIVE, FLUX_COOLDOWN, NITRO_ACTIVE, NITRO_COOLDOWN, FLIP_P, LEVS, FLOORS, SPIKE_SEQS, DRIFT_SEQS, STRIDE_REAL },
  provenance: { calm: calm.meta, fresh: fresh.meta, spike: "synthetic 1s calibrated to real high-vol SOL window", driftless: "pure-martingale GBM @4.19e-4/s" },
  totalRoundSims: [...cells.values()].reduce((a, c) => a + c.n, 0),
  rows,
  secs: (Date.now() - t0) / 1000,
};
writeFileSync(join(DIR, "abilities-out.json"), JSON.stringify(out, null, 1));

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—").padStart(7);
console.log(`abilities sim: ${out.totalRoundSims.toLocaleString()} round-sims in ${out.secs.toFixed(1)}s\n`);
for (const market of ["calm", "fresh", "spike", "driftless"]) {
  console.log(`== ${market} ==`);
  console.log("  arm       lev  liq | fire%  | liq% base→arm  | houseEV% base→arm | Δhouse% ±95CI");
  for (const r of rows.filter((r) => r.market === market).sort((a, b) => a.arm.localeCompare(b.arm) || a.liq - b.liq || a.lev - b.lev)) {
    console.log(
      `${r.arm.padEnd(9)}${String(r.lev).padStart(5)}  ${r.liq.toFixed(2)} |${f(r.fireRatePct)} |${f(r.baseLiqPct)}→${f(r.outcomes.liqPct)} |` +
      `${f(r.baseHouseEvPct)}→${f(r.armHouseEvPct)} |${f(r.houseDeltaPct, 3)}±${Number.isFinite(r.houseDeltaCi95) ? r.houseDeltaCi95.toFixed(3) : "—"}`
    );
  }
  console.log();
}
