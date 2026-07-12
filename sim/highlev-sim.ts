// =============================================================================
// House-economics Monte-Carlo for the leveraged arcade-perp game (Perps Rider).
//
// Faithful to packages/engine: imports equityOf + payoutOf DIRECTLY and replicates
// ONLY the finalize outcome->equity mapping (liq=0, cap=CAP, cashout=equityOf) and
// the settlement precedence (liq -> cap -> time -> cashout). See settle-pertick.ts.
//
// MODELING DECISION: PER-TICK evaluation (every 1s tick checks liq/cap/time), which
// is the planned autonomous-settler target and the conservative choice for house
// risk. Production settle.ts today is marks-only (open/actions/exit) which is even
// MORE house-favorable (fewer barrier triggers). Noted in output.
//
// Matrix: leverage {100,500,1000,2000} x playerModel {independent,net-directional}
//         x market {calm,spike}. Per cell: ev/turnover, liq/cap/cashout rates,
//         max drawdown %, worst single-tick correlated payout (xStake), ruin prob.
//
// Price paths: real Binance SOL 1s for calm; synthetic-calibrated-to-real-spike for
// spike (see paths.ts / fetch-data.mjs). Driftless martingale cross-check: crosscheck.ts.
// =============================================================================
import { equityOf, payoutOf } from "../packages/engine/src/economics.ts";
import { BASE_CONFIG } from "../packages/engine/src/config.ts";
import type { Position, SettleReason, Dir } from "../packages/engine/src/types.ts";
import { buildCalm, buildSpike, rng } from "./paths.ts";

const cfg = BASE_CONFIG; // EDGE .05, LIQ .2, CAP 25, MAXSEC 60, MAX_STAKE 5000
const MAX_STAKE = 5000;
const MIN_STAKE = 25;

// ---- one round, per-tick, faithful to engine finalize ----
interface RoundOut {
  outcome: SettleReason;
  payoutCoins: number;
  stake: number;
}

type Policy =
  | { kind: "ride" }
  | { kind: "target"; targetEquity: number }
  | { kind: "scared"; targetEquity: number; maxTicks: number };

function runRound(
  prices: number[],
  entryIdx: number,
  dir: Dir,
  lev: number,
  stake: number,
  policy: Policy,
): RoundOut {
  const entryRaw = prices[entryIdx];
  const pos: Position = { dir, lev, entryRaw, banked: 0 };
  const end = Math.min(prices.length - 1, entryIdx + cfg.MAXSEC);
  for (let i = entryIdx; i <= end; i++) {
    const price = prices[i];
    const eq = equityOf(pos, price);
    let outcome: SettleReason | null = null;
    if (eq <= cfg.LIQ) outcome = "liq";
    else if (eq >= cfg.CAP) outcome = "cap";
    else if (i - entryIdx >= cfg.MAXSEC) outcome = "time";
    if (!outcome && i > entryIdx) {
      if (policy.kind === "target" && eq >= policy.targetEquity) outcome = "cashout";
      else if (policy.kind === "scared" && (eq >= policy.targetEquity || i - entryIdx >= policy.maxTicks)) outcome = "cashout";
    }
    if (outcome) {
      const equity = outcome === "liq" ? 0 : outcome === "cap" ? cfg.CAP : eq;
      const payoutCoins = Math.floor(payoutOf(stake, equity, cfg.EDGE));
      return { outcome, payoutCoins, stake };
    }
  }
  // reached end of usable window: settle as cashout at last evaluated price
  const price = prices[end];
  const equity = equityOf(pos, price);
  return { outcome: "cashout", payoutCoins: Math.floor(payoutOf(stake, equity, cfg.EDGE)), stake };
}

// ---- player sampling ----
function sampleStake(r: () => number): number {
  // realistic spread: many small, some at the cap. Log-uniform-ish in [MIN_STAKE, MAX_STAKE].
  const lo = Math.log(MIN_STAKE), hi = Math.log(MAX_STAKE);
  return Math.max(MIN_STAKE, Math.min(MAX_STAKE, Math.round(Math.exp(lo + r() * (hi - lo)))));
}

function samplePolicy(r: () => number): Policy {
  const u = r();
  if (u < 1 / 3) return { kind: "ride" };
  if (u < 2 / 3) {
    // greedy target: cash out at +X% equity, X spread across players (1.5x .. 12x equity)
    const targetEquity = 1.5 + r() * 10.5;
    return { kind: "target", targetEquity };
  }
  // scared: small profit (1.05..1.5x) OR bail after a few ticks (3..15)
  return { kind: "scared", targetEquity: 1.05 + r() * 0.45, maxTicks: 3 + Math.floor(r() * 13) };
}

// =============================================================================
// Cell runner. Tracks a HOUSE bankroll over a sequence of rounds across many
// Monte-Carlo sequences. Returns aggregate stats.
// =============================================================================
interface CellStats {
  rounds: number;
  houseEvPctTurnover: number;
  liqRate: number;
  capRate: number;
  cashoutRate: number;
  timeRate: number;
  maxDrawdownPctOfBankroll: number;   // averaged worst peak-to-trough across sequences
  worstSingleTickPayoutXStake: number; // worst correlated 1-tick summed payout / single stake
  ruinProb: number;
  bankrollUnits: number;              // starting bankroll in multiples of MAX_STAKE
}

interface CellCfg {
  lev: number;
  model: "independent" | "net-directional";
  market: "calm" | "spike";
  totalRounds: number;
  sequences: number;          // Monte-Carlo bankroll sequences
  bankrollUnits: number;      // start bankroll = bankrollUnits * MAX_STAKE (coins)
  seed: number;
}

function buildPaths(market: "calm" | "spike", lenTicks: number, seed: number) {
  return market === "calm" ? buildCalm(lenTicks) : buildSpike(lenTicks, seed);
}

function runCell(c: CellCfg): { stats: CellStats; pathNote: string } {
  const r = rng(c.seed);
  // Build a long price path so entries can be spread across time. Reuse one realization
  // per cell (calm = real data; spike = one calibrated realization) — bankroll sequences
  // sample different entry windows within it.
  const PATH_TICKS = 400_000;
  const built = buildPaths(c.market, PATH_TICKS, c.seed ^ 0x9e3779b9);
  const prices = built.prices;
  const usableMax = prices.length - cfg.MAXSEC - 2;

  const startBankroll = c.bankrollUnits * MAX_STAKE;

  // global tallies for rates/ev
  let nLiq = 0, nCap = 0, nCash = 0, nTime = 0;
  let sumStake = 0, sumPayout = 0;
  let roundsRun = 0;

  // correlated worst single-tick payout (net-directional clusters)
  let worstTickPayoutCoins = 0;
  let worstTickStake = MAX_STAKE; // for normalization we track the per-round stake in that tick

  // per-sequence drawdown + ruin
  let sumMaxDDpct = 0;
  let ruinCount = 0;

  const roundsPerSeq = Math.max(1, Math.floor(c.totalRounds / c.sequences));

  for (let s = 0; s < c.sequences; s++) {
    let bankroll = startBankroll;
    let peak = startBankroll;
    let maxDDpct = 0;
    let ruined = false;

    let processed = 0;
    while (processed < roundsPerSeq) {
      if (c.model === "independent") {
        // one uncorrelated round at a random entry tick
        const entryIdx = Math.floor(r() * usableMax);
        const dir: Dir = r() < 0.5 ? 1 : -1;
        const stake = sampleStake(r);
        const policy = samplePolicy(r);
        const out = runRound(prices, entryIdx, dir, c.lev, stake, policy);
        bankroll += stake - out.payoutCoins; // house gains stake, pays payout
        tally(out);
        // single-round "tick" payout
        if (out.payoutCoins > worstTickPayoutCoins) { worstTickPayoutCoins = out.payoutCoins; worstTickStake = stake; }
        peak = Math.max(peak, bankroll);
        const dd = (peak - bankroll) / startBankroll;
        if (dd > maxDDpct) maxDDpct = dd;
        if (bankroll <= 0 && !ruined) { ruined = true; }
        processed++;
      } else {
        // net-directional: a CORRELATED BURST of players, ~80% LONG, same leverage,
        // all opening within the same short window -> same entry tick (worst case for
        // simultaneous cap-hits). One favorable move can cap many at once.
        const burst = 20 + Math.floor(r() * 60); // 20..80 players in the burst
        const entryIdx = Math.floor(r() * usableMax);
        let burstPayout = 0;
        let burstStakeAtEntry = 0;
        // Evaluate the whole burst; also compute the worst SINGLE-tick summed payout by
        // bucketing each player's settlement by its settle-tick offset.
        const tickBuckets = new Map<number, number>(); // tickOffset -> summed payout
        for (let b = 0; b < burst && processed < roundsPerSeq; b++) {
          const dir: Dir = r() < 0.8 ? 1 : -1; // 80% long
          const stake = sampleStake(r);
          const policy = samplePolicy(r);
          const out = runRoundWithTick(prices, entryIdx, dir, c.lev, stake, policy);
          bankroll += stake - out.payoutCoins;
          tally(out);
          burstPayout += out.payoutCoins;
          burstStakeAtEntry += stake;
          tickBuckets.set(out.settleTick, (tickBuckets.get(out.settleTick) ?? 0) + out.payoutCoins);
          processed++;
          peak = Math.max(peak, bankroll);
          const dd = (peak - bankroll) / startBankroll;
          if (dd > maxDDpct) maxDDpct = dd;
        }
        if (bankroll <= 0 && !ruined) ruined = true;
        // worst single-tick correlated payout in this burst
        let burstWorstTick = 0;
        for (const v of tickBuckets.values()) if (v > burstWorstTick) burstWorstTick = v;
        if (burstWorstTick > worstTickPayoutCoins) {
          worstTickPayoutCoins = burstWorstTick;
          // normalize by the AVERAGE stake in the burst (xStake = correlated payout / one stake)
          worstTickStake = Math.max(1, Math.round(burstStakeAtEntry / Math.max(1, burst)));
        }
      }
    }
    sumMaxDDpct += maxDDpct;
    if (ruined) ruinCount++;
  }

  function tally(out: RoundOut) {
    roundsRun++;
    sumStake += out.stake;
    sumPayout += out.payoutCoins;
    if (out.outcome === "liq") nLiq++;
    else if (out.outcome === "cap") nCap++;
    else if (out.outcome === "time") nTime++;
    else nCash++;
  }

  const stats: CellStats = {
    rounds: roundsRun,
    houseEvPctTurnover: (sumStake - sumPayout) / sumStake,
    liqRate: nLiq / roundsRun,
    capRate: nCap / roundsRun,
    cashoutRate: nCash / roundsRun,
    timeRate: nTime / roundsRun,
    maxDrawdownPctOfBankroll: (sumMaxDDpct / c.sequences) * 100,
    worstSingleTickPayoutXStake: worstTickPayoutCoins / worstTickStake,
    ruinProb: ruinCount / c.sequences,
    bankrollUnits: c.bankrollUnits,
  };
  return { stats, pathNote: built.meta.note ?? built.meta.source };
}

// variant that also reports the tick offset at which the round settled (for correlated
// single-tick bucketing). Faithful to the same finalize mapping.
function runRoundWithTick(
  prices: number[], entryIdx: number, dir: Dir, lev: number, stake: number, policy: Policy,
): RoundOut & { settleTick: number } {
  const entryRaw = prices[entryIdx];
  const pos: Position = { dir, lev, entryRaw, banked: 0 };
  const end = Math.min(prices.length - 1, entryIdx + cfg.MAXSEC);
  for (let i = entryIdx; i <= end; i++) {
    const price = prices[i];
    const eq = equityOf(pos, price);
    let outcome: SettleReason | null = null;
    if (eq <= cfg.LIQ) outcome = "liq";
    else if (eq >= cfg.CAP) outcome = "cap";
    else if (i - entryIdx >= cfg.MAXSEC) outcome = "time";
    if (!outcome && i > entryIdx) {
      if (policy.kind === "target" && eq >= policy.targetEquity) outcome = "cashout";
      else if (policy.kind === "scared" && (eq >= policy.targetEquity || i - entryIdx >= policy.maxTicks)) outcome = "cashout";
    }
    if (outcome) {
      const equity = outcome === "liq" ? 0 : outcome === "cap" ? cfg.CAP : eq;
      const payoutCoins = Math.floor(payoutOf(stake, equity, cfg.EDGE));
      return { outcome, payoutCoins, stake, settleTick: i - entryIdx };
    }
  }
  const price = prices[end];
  const equity = equityOf(pos, price);
  return { outcome: "cashout", payoutCoins: Math.floor(payoutOf(stake, equity, cfg.EDGE)), stake, settleTick: end - entryIdx };
}

// =============================================================================
// Run the full matrix.
// =============================================================================
const LEVS = [100, 500, 1000, 2000];
const MODELS = ["independent", "net-directional"] as const;
const MARKETS = ["calm", "spike"] as const;
const BANKROLL_UNITS = 500; // starting house bankroll = 500 x MAX_STAKE = $25,000 (2.5M coins)

const ROUNDS_PER_CELL = Number(process.env.ROUNDS ?? 150_000);
const SEQUENCES = Number(process.env.SEQS ?? 200);

const results: any[] = [];
let provenanceNote = "";
let seed = 1000;
for (const market of MARKETS) {
  for (const model of MODELS) {
    for (const lev of LEVS) {
      const t0 = Date.now();
      const { stats, pathNote } = runCell({
        lev, model, market,
        totalRounds: ROUNDS_PER_CELL,
        sequences: SEQUENCES,
        bankrollUnits: BANKROLL_UNITS,
        seed: seed++,
      });
      provenanceNote = pathNote;
      const row = {
        leverage: lev,
        playerModel: model,
        market,
        houseEvPctTurnover: +(stats.houseEvPctTurnover * 100).toFixed(3),
        liqRate: +(stats.liqRate * 100).toFixed(3),
        capRate: +(stats.capRate * 100).toFixed(3),
        cashoutRate: +(stats.cashoutRate * 100).toFixed(3),
        timeRate: +(stats.timeRate * 100).toFixed(3),
        maxDrawdownPctOfBankroll: +stats.maxDrawdownPctOfBankroll.toFixed(3),
        worstSingleTickPayoutXStake: +stats.worstSingleTickPayoutXStake.toFixed(2),
        ruinProbAtBankroll: +stats.ruinProb.toFixed(4),
        rounds: stats.rounds,
        ms: Date.now() - t0,
      };
      results.push(row);
      console.error(`[${market}/${model}/${lev}] ev=${row.houseEvPctTurnover}% liq=${row.liqRate}% cap=${row.capRate}% co=${row.cashoutRate}% maxDD=${row.maxDrawdownPctOfBankroll}% worstTickX=${row.worstSingleTickPayoutXStake} ruin=${row.ruinProbAtBankroll} (${row.rounds} rounds, ${row.ms}ms)`);
    }
  }
}

console.log(JSON.stringify({
  bankrollUnits: BANKROLL_UNITS,
  bankrollDollars: (BANKROLL_UNITS * MAX_STAKE) / 100,
  roundsPerCell: ROUNDS_PER_CELL,
  sequences: SEQUENCES,
  spikePathNote: provenanceNote,
  results,
}, null, 2));
