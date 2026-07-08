// Helmet "Auto-Swerve" house-economics sim — is the auto-flip-at-death's-door too
// strong against the house?
//
// Method: PAIRED replay. Every round is simulated twice on the IDENTICAL price
// window, direction, leverage and liq floor — once bare, once with the swerve rule
// (once per round, at engine bufferOf(eq,LIQ) <= SWERVE_BUFFER, flip = engine
// rebank at the mark + dir reversed; terminal-first: a tick that lands <= LIQ
// liquidates BEFORE the swerve can fire, exactly like the on-chain tick).
// The house delta is measured on the per-round paired difference, which cancels
// path drift and slashes variance.
//
// Faithful to production money math: equityOf / payoutOf / bufferOf / rebank are
// imported DIRECTLY from packages/engine. Finalize map (liq=0, cap=CAP, time=eq)
// and per-tick precedence liq -> cap -> time mirror sim/highlev-sim.ts + the
// on-chain tick.
//
// Markets:
//   calm     real Binance SOL 1s closes (June window, cached)
//   fresh    real Binance SOL 1s closes (fetched 2026-07-03, today's tape)
//   spike    synthetic 1s calibrated to the real highest-vol SOL hour (many seeds)
//   driftless pure-martingale GBM at spike-like vol (theory check: delta should be ~0)
//
// Run: node sim/swerve-sim.ts   (env: SPIKE_SEQS, DRIFT_SEQS, STRIDE_REAL)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equityOf, payoutOf, bufferOf, rebank } from "../packages/engine/src/economics.ts";
import { buildSpike, buildDriftless } from "./paths.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "data");
const SWERVE_BUFFER = 0.10;       // redline3d/src/core/swerve.ts
const EDGE = 0.05, CAP = 25, MAXSEC = 60;
const LEVS = [50, 200, 500, 1000, 2000, 3000];
const FLOORS = [0.10, 0.20];      // Suspension-upgraded / stock liq floor
const SPIKE_SEQS = Number(process.env.SPIKE_SEQS ?? 400);
const DRIFT_SEQS = Number(process.env.DRIFT_SEQS ?? 200);
const STRIDE_REAL = Number(process.env.STRIDE_REAL ?? 1);

type Pos = { banked: number; dir: 1 | -1; lev: number; entryRaw: number };
type Outcome = "liq" | "cap" | "time";
interface RoundRes { outcome: Outcome; mult: number; fired: boolean }

/** one 60s round, per-tick settle; mult = payout multiple of stake (edge included) */
function runRound(prices: number[], start: number, dir: 1 | -1, lev: number, LIQ: number, swerve: boolean): RoundRes {
  let pos: Pos = { banked: 0, dir, lev, entryRaw: prices[start] };
  let fired = false;
  for (let t = 1; t <= MAXSEC; t++) {
    const p = prices[start + t];
    const eq = equityOf(pos, p);
    if (eq <= LIQ) return { outcome: "liq", mult: 0, fired };                     // terminal-first
    if (eq >= CAP) return { outcome: "cap", mult: payoutOf(1, CAP, EDGE), fired };
    if (swerve && !fired && bufferOf(eq, LIQ) <= SWERVE_BUFFER) {
      pos = { ...rebank(pos, p), dir: (pos.dir === 1 ? -1 : 1) as 1 | -1 };       // stop-and-reverse at the mark
      fired = true;
    }
    if (t === MAXSEC) return { outcome: "time", mult: payoutOf(1, eq, EDGE), fired };
  }
  throw new Error("unreachable");
}

interface Cell {
  n: number; fired: number;
  base: { liq: number; cap: number; time: number; sumMult: number };
  sw: { liq: number; cap: number; time: number; sumMult: number };
  // paired per-round diff (swerve - base) in payout multiple
  sumD: number; sumD2: number; blockMeans: number[]; blockSum: number; blockN: number;
  // conditional on the swerve actually firing
  saved: number; killed: number; bothLiq: number; bothLive: number; sumDFired: number;
}
const newCell = (): Cell => ({
  n: 0, fired: 0,
  base: { liq: 0, cap: 0, time: 0, sumMult: 0 },
  sw: { liq: 0, cap: 0, time: 0, sumMult: 0 },
  sumD: 0, sumD2: 0, blockMeans: [], blockSum: 0, blockN: 0,
  saved: 0, killed: 0, bothLiq: 0, bothLive: 0, sumDFired: 0,
});
const BLOCK = 240; // block means absorb overlapping-window correlation in the CI

function addPair(c: Cell, b: RoundRes, s: RoundRes) {
  c.n++;
  if (s.fired) c.fired++;
  c.base[b.outcome]++; c.base.sumMult += b.mult;
  c.sw[s.outcome]++; c.sw.sumMult += s.mult;
  const d = s.mult - b.mult;
  c.sumD += d; c.sumD2 += d * d;
  c.blockSum += d; if (++c.blockN === BLOCK) { c.blockMeans.push(c.blockSum / BLOCK); c.blockSum = 0; c.blockN = 0; }
  if (s.fired) {
    c.sumDFired += d;
    const bl = b.outcome === "liq", sl = s.outcome === "liq";
    if (bl && !sl) c.saved++;
    else if (!bl && sl) c.killed++;
    else if (bl && sl) c.bothLiq++;
    else c.bothLive++;
  }
}

function runMarket(name: string, priceSets: number[][], stride: number, cells: Map<string, Cell>) {
  for (const prices of priceSets) {
    const lastStart = prices.length - MAXSEC - 1;
    for (let start = 0; start <= lastStart; start += stride) {
      for (const dir of [1, -1] as const) {
        for (const lev of LEVS) for (const LIQ of FLOORS) {
          const key = `${name}|${lev}|${LIQ}`;
          let c = cells.get(key);
          if (!c) { c = newCell(); cells.set(key, c); }
          addPair(c, runRound(prices, start, dir, lev, LIQ, false), runRound(prices, start, dir, lev, LIQ, true));
        }
      }
    }
  }
}

const load = (f: string) => JSON.parse(readFileSync(join(DIR, `${f}.json`), "utf8")) as { meta: any; closes: number[] };

const t0 = Date.now();
const cells = new Map<string, Cell>();
const calm = load("calm"), fresh = load("fresh");
runMarket("calm", [calm.closes.filter((x: number) => x > 0)], STRIDE_REAL, cells);
runMarket("fresh", [fresh.closes.filter((x: number) => x > 0)], STRIDE_REAL, cells);
runMarket("spike", Array.from({ length: SPIKE_SEQS }, (_, i) => buildSpike(3660, 1000 + i).prices), 60, cells);
runMarket("driftless", Array.from({ length: DRIFT_SEQS }, (_, i) => buildDriftless(3660, 4.19e-4, 5000 + i).prices), 60, cells);

const rows: any[] = [];
for (const [key, c] of cells) {
  const [market, lev, liq] = key.split("|");
  const meanB = c.base.sumMult / c.n, meanS = c.sw.sumMult / c.n;
  const dMean = c.sumD / c.n;
  // CI from block means (overlap-robust); fall back to iid if too few blocks
  let ci: number;
  if (c.blockMeans.length >= 8) {
    const bm = c.blockMeans, m = bm.reduce((a, b) => a + b, 0) / bm.length;
    const v = bm.reduce((a, b) => a + (b - m) * (b - m), 0) / (bm.length - 1);
    ci = 1.96 * Math.sqrt(v / bm.length);
  } else {
    const v = c.sumD2 / c.n - dMean * dMean;
    ci = 1.96 * Math.sqrt(v / c.n);
  }
  rows.push({
    market, lev: +lev, liq: +liq, pairs: c.n,
    fireRatePct: (100 * c.fired) / c.n,
    base: { liqPct: (100 * c.base.liq) / c.n, capPct: (100 * c.base.cap) / c.n, timePct: (100 * c.base.time) / c.n, meanMult: meanB, houseEvPct: 100 * (1 - meanB) },
    swerve: { liqPct: (100 * c.sw.liq) / c.n, capPct: (100 * c.sw.cap) / c.n, timePct: (100 * c.sw.time) / c.n, meanMult: meanS, houseEvPct: 100 * (1 - meanS) },
    houseDeltaPct: -100 * dMean,        // negative mult delta = house gains
    houseDeltaCi95: 100 * ci,
    onFired: { fired: c.fired, saved: c.saved, killed: c.killed, bothLiq: c.bothLiq, bothLive: c.bothLive, meanPlayerDeltaMult: c.fired ? c.sumDFired / c.fired : 0 },
  });
}

const out = {
  ranAt: new Date().toISOString(),
  config: { EDGE, CAP, MAXSEC, SWERVE_BUFFER, LEVS, FLOORS, SPIKE_SEQS, DRIFT_SEQS, STRIDE_REAL, BLOCK },
  provenance: {
    calm: calm.meta, fresh: fresh.meta,
    spike: "synthetic 1s calibrated to real high-vol SOL window (sim/paths.ts buildSpike)",
    driftless: "pure-martingale GBM @4.19e-4/s (theory check)",
  },
  totalPairs: rows.reduce((a, r) => a + r.pairs, 0),
  rows,
  secs: (Date.now() - t0) / 1000,
};
writeFileSync(join(DIR, "swerve-out.json"), JSON.stringify(out, null, 1));

// ---- console table ----
const f = (x: number, d = 2) => x.toFixed(d).padStart(7);
console.log(`swerve sim: ${out.totalPairs.toLocaleString()} paired rounds (${(2 * out.totalPairs).toLocaleString()} round-sims) in ${out.secs.toFixed(1)}s\n`);
for (const market of ["calm", "fresh", "spike", "driftless"]) {
  console.log(`== ${market} ==`);
  console.log("  lev  liq | fire%  | liq% base→sw   | houseEV% base→sw | Δhouse% ±95CI    | fired: saved/killed/bothLiq/bothLive");
  for (const r of rows.filter((r) => r.market === market).sort((a, b) => a.liq - b.liq || a.lev - b.lev)) {
    console.log(
      `${String(r.lev).padStart(5)}  ${r.liq.toFixed(2)} |${f(r.fireRatePct)} |${f(r.base.liqPct)}→${f(r.swerve.liqPct)} |` +
      `${f(r.base.houseEvPct)}→${f(r.swerve.houseEvPct)} |${f(r.houseDeltaPct, 3)}±${r.houseDeltaCi95.toFixed(3)} | ` +
      `${r.onFired.saved}/${r.onFired.killed}/${r.onFired.bothLiq}/${r.onFired.bothLive}`
    );
  }
  console.log();
}
