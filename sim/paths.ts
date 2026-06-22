// Price-path construction for the house-economics sim.
//
// CALM:  real Binance SOL 1s closes, replayed (and tiled/looped if the sim needs
//        more ticks than the cached window). This is genuine 1s micro-structure.
//
// SPIKE: a synthetic 1s path CALIBRATED to the real highest-vol 60-min SOL window
//        (per-sec vol derived from the real per-min vol of that window) with REAL-
//        magnitude jump candles injected at the rate observed in that window. We
//        synthesize because Binance 1s history only reaches back ~2h, so the real
//        volatile day (2026-06-17) is not available at 1s granularity. Reported in
//        dataProvenance.
//
// DRIFTLESS: a zero-drift synthetic path for the martingale cross-check.
//
// All paths are arrays of positive prices, one entry per 1s tick.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

export interface PathMeta {
  source: string;
  perSecVol: number;
  note?: string;
}

function load(name: string): { meta: any; closes: number[] } {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));
}

// Deterministic PRNG (mulberry32) so runs are reproducible.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface BuiltPath {
  prices: number[];
  meta: PathMeta;
}

/** Real calm 1s closes, tiled to `len` ticks (reflecting at the ends to avoid a seam jump). */
export function buildCalm(len: number): BuiltPath {
  const { meta, closes } = load("calm");
  const src = closes.filter((x) => x > 0);
  const prices: number[] = new Array(len);
  // reflective tiling of the real series
  const period = 2 * (src.length - 1);
  for (let i = 0; i < len; i++) {
    let k = i % period;
    if (k >= src.length) k = period - k;
    prices[i] = src[k];
  }
  return {
    prices,
    meta: { source: meta.source, perSecVol: meta.perSecVol, note: `real 1s closes, ${src.length} candles ${meta.fromIso}..${meta.toIso}, reflective-tiled` },
  };
}

/**
 * Spike 1s path calibrated to the real high-vol window.
 * - base diffusion: per-sec vol = realPerMinVol / sqrt(60)
 * - injected jumps: Poisson with rate matching ~1 large (>=0.5%) move/min observed,
 *   magnitude drawn up to the real max single-min move (~1.47%), random sign.
 */
export function buildSpike(len: number, seed: number): BuiltPath {
  const { meta } = load("spike");
  const perMinVol: number = meta.perMinVol;            // real ~3.25e-3
  const perSecVol = perMinVol / Math.sqrt(60);         // ~4.19e-4
  const maxJump = meta.maxSingleMinMovePct / 100;      // ~0.0147
  const r = rng(seed);
  const prices = new Array<number>(len);
  let p = 150; // arbitrary positive base; only ratios matter to equityOf
  // jump rate: roughly one >=0.5% move per minute in the real window -> ~1/60 per sec.
  const jumpPerSec = 1 / 60;
  for (let i = 0; i < len; i++) {
    let ret = perSecVol * gauss(r);
    if (r() < jumpPerSec) {
      // jump magnitude: 0.5%..maxJump, random sign — real-magnitude shock candle
      const mag = 0.005 + r() * (maxJump - 0.005);
      ret += (r() < 0.5 ? -1 : 1) * mag;
    }
    p = p * Math.exp(ret);
    prices[i] = p;
  }
  return {
    prices,
    meta: { source: meta.source, perSecVol, note: `synthetic 1s calibrated to real window perMinVol=${perMinVol.toExponential(2)} (perSecVol=${perSecVol.toExponential(2)}), real-magnitude jumps up to ${(maxJump * 100).toFixed(2)}%/tick at ~1/min` },
  };
}

/**
 * Driftless ARITHMETIC price walk for the martingale cross-check.
 * price_{t+1} = price_t + sigmaAbs * N(0,1), reflected away from 0. Because the
 * increments are additive and zero-mean, price/entry is a symmetric driftless
 * random walk, so equity = 1 + dir*lev*(price/entry - 1) is a clean symmetric walk
 * between the LIQ and CAP barriers — exactly the gambler's-ruin setup the prediction
 * P(cap)=(1-LIQ)/(CAP-LIQ) assumes. (Multiplicative GBM injects a long/short asymmetry
 * over long rides via log-drift and does NOT converge to the prediction.)
 * sigmaAbs is chosen small relative to base so per-tick equity steps are tiny.
 */
export function buildDriftlessArith(len: number, levForStep: number, equityStep: number, seed: number): BuiltPath {
  const r = rng(seed);
  const prices = new Array<number>(len);
  const base = 1_000_000; // large base so additive steps keep price>0 and ratios are clean
  // want lev * (dPrice/base) ~ equityStep  => dPrice = equityStep*base/lev
  const sigmaAbs = (equityStep * base) / levForStep;
  let p = base;
  for (let i = 0; i < len; i++) {
    p = p + sigmaAbs * gauss(r);
    if (p < base * 0.01) p = base * 0.01 + (base * 0.01 - p); // reflect away from 0 (rare)
    prices[i] = p;
  }
  return { prices, meta: { source: "synthetic driftless arithmetic walk (martingale in price/entry)", perSecVol: sigmaAbs / base, note: `equityStep~${equityStep} at lev=${levForStep}` } };
}

/** Driftless GBM at a chosen per-sec vol (kept for reference; not used in cross-check). */
export function buildDriftless(len: number, perSecVol: number, seed: number): BuiltPath {
  const r = rng(seed);
  const prices = new Array<number>(len);
  let p = 150;
  for (let i = 0; i < len; i++) {
    // zero drift, no Ito correction subtraction (we want a true martingale in PRICE,
    // i.e. E[price_{t+1}]≈price_t). Using log-return with -0.5*sig^2 keeps E[P] a martingale.
    const ret = -0.5 * perSecVol * perSecVol + perSecVol * gauss(r);
    p = p * Math.exp(ret);
    prices[i] = p;
  }
  return { prices, meta: { source: "synthetic driftless GBM (martingale in price)", perSecVol, note: "cross-check path" } };
}
