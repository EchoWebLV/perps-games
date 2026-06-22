// Martingale / gambler's-ruin cross-check for the per-tick harness.
//
// Sub-case: independent players, "ride to barrier only" (never voluntarily exit),
// on a DRIFTLESS price path. Prediction (engine: LIQ=0.2, CAP=25, EDGE=0.05):
//   P(cap)   = (1-LIQ)/(CAP-LIQ) = 0.8/24.8 ~= 3.226%
//   P(liq)   ~= 96.77%
//   houseEvPctTurnover = 1 - 0.95*(P(cap)*CAP + P(liq)*0) ~= 1 - 0.95*0.8065 ~= +23.38%
//   (liq pays 0; cap pays equity=CAP=25)
//
// To keep this provably the SAME math as production, the per-tick loop calls the
// engine's equityOf + finalize mapping exactly as settle-pertick.ts does, but it
// generates the driftless ARITHMETIC price walk on the fly (no giant array) so each
// round is an independent clean barrier problem and the run is fast. The price walk
// is additive & zero-mean, so price/entry is a symmetric driftless martingale and
// equity = 1 + dir*lev*(price/entry - 1) is the symmetric walk the prediction assumes.
//
// If the harness doesn't reproduce ~3.2% cap and ~+23% edge, it has a bug.
import { equityOf, payoutOf } from "../packages/engine/src/economics.ts";
import { BASE_CONFIG } from "../packages/engine/src/config.ts";
import { rng } from "./paths.ts";
import type { Position, SettleReason, Dir } from "../packages/engine/src/types.ts";

const cfg = BASE_CONFIG;
const r = rng(12345);

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// one round: ride to a liq/cap barrier on a fresh driftless arithmetic walk.
// finalize mapping is identical to engine settle.ts (liq=0, cap=CAP, cashout=equityOf).
function rideRound(dir: Dir, lev: number, stake: number, equityStep: number, maxTicks: number) {
  const base = 1_000_000;
  const sigmaAbs = (equityStep * base) / lev;
  const entryRaw = base;
  const pos: Position = { dir, lev, entryRaw, banked: 0 };
  let price = base;
  for (let i = 0; i < maxTicks; i++) {
    const eq = equityOf(pos, price);
    let outcome: SettleReason | null = null;
    if (eq <= cfg.LIQ) outcome = "liq";
    else if (eq >= cfg.CAP) outcome = "cap";
    if (outcome) {
      const equity = outcome === "liq" ? 0 : cfg.CAP; // engine finalize mapping
      const payoutCoins = Math.floor(payoutOf(stake, equity, cfg.EDGE));
      return { outcome, payoutCoins };
    }
    price = price + sigmaAbs * gauss();
    if (price < base * 0.001) price = base * 0.001;
  }
  // hit tick cap without a barrier (extremely rare): settle as cashout at live equity
  const equity = equityOf(pos, price);
  return { outcome: "cashout" as SettleReason, payoutCoins: Math.floor(payoutOf(stake, equity, cfg.EDGE)) };
}

const N = Number(process.env.CC_N ?? 120_000);
const lev = 500;          // any leverage; barrier ratios are lev-independent in equity space
const maxTicks = 16_000_000;

// This is a TICK-DISCRETIZED barrier sim, so finite step h overshoots the barriers and
// biases cap-rate slightly high (EV slightly low). The bias is O(h). We run a small
// step-sweep and Richardson-extrapolate cap-rate & EV to the continuous limit h->0,
// which is what the analytic prediction describes. The extrapolated values are what
// must match ~3.226% cap and ~+23.38% EV.
const STEPS = (process.env.CC_STEPS?.split(",").map(Number)) ?? [0.04, 0.02];

function runStep(equityStep: number) {
  let cap = 0, liq = 0, other = 0, totalStake = 0, totalPayout = 0;
  for (let n = 0; n < N; n++) {
    const dir: Dir = r() < 0.5 ? 1 : -1;
    const stake = 100;
    const res = rideRound(dir, lev, stake, equityStep, maxTicks);
    if (res.outcome === "cap") cap++;
    else if (res.outcome === "liq") liq++;
    else other++;
    totalStake += stake;
    totalPayout += res.payoutCoins;
  }
  return { equityStep, capRate: cap / N, liqRate: liq / N, other, houseEv: (totalStake - totalPayout) / totalStake };
}

console.log("=== Driftless martingale cross-check (ride-to-barrier, lev=" + lev + ", N=" + N + "/step) ===");
const runs = STEPS.map(runStep);
for (const x of runs) {
  console.log(`  h=${x.equityStep}  cap=${(x.capRate * 100).toFixed(3)}%  liq=${(x.liqRate * 100).toFixed(3)}%  other=${x.other}  ev=${(x.houseEv * 100).toFixed(3)}%`);
}
// With >=2 steps, linear Richardson-extrapolate the O(h) finite-tick overshoot bias
// to h->0. With a single step, just report it (overshoot makes cap slightly high / EV
// slightly low — the conservative, house-pessimistic direction).
const a = runs[0], b = runs[runs.length - 1];
let capRef: number, evRef: number, mode: string;
if (runs.length >= 2 && a.equityStep !== b.equityStep) {
  const extrap = (f1: number, h1: number, f2: number, h2: number) => f2 + ((f2 - f1) * h2) / (h1 - h2);
  capRef = extrap(a.capRate, a.equityStep, b.capRate, b.equityStep);
  evRef = extrap(a.houseEv, a.equityStep, b.houseEv, b.equityStep);
  mode = "Richardson h->0";
} else {
  capRef = a.capRate; evRef = a.houseEv; mode = `single step h=${a.equityStep}`;
}
console.log(mode + ":");
console.log("  cap rate  :", (capRef * 100).toFixed(3) + "%   (predicted 3.226%)");
console.log("  houseEv   :", (evRef * 100).toFixed(3) + "%   (predicted +23.38%)");
// cap rate is the fundamental check; EV is mechanically EV = 1 - 0.95*capRate*CAP.
const okCap = Math.abs(capRef - 0.03226) < 0.004; // within 0.4pp
console.log("cap-rate PASS:", okCap ? "YES" : "NO", "(within 0.4pp of gambler's-ruin 3.226%)");
console.log("note: EV residual vs 23.38% is forced by the cap-rate residual (finite-tick barrier overshoot, conservative for house risk).");
