import { CONFIG } from "./config";
import type { Dir, Phase, SettleReason, Position, Snapshot } from "./types";
import { equityOf, payoutOf, bufferOf, rebank } from "./economics";

export interface LaunchParams {
  dir: Dir;
  lev: number;
  stake: number;
  entryRaw: number;
  /** Realized fixed-point PnL restored from the on-chain segment, expressed as equity units. */
  banked?: number;
  startMs: number;
  /** per-round time cap in seconds (Six Wheeler Heavy Load runs longer); defaults to CONFIG.MAXSEC */
  maxSec?: number;
  /** Daily borrow rate in basis points of notional. Highway uses 1; Track defaults to 0. */
  borrowBpsPerDay?: number;
}

const DAY_MS = 86_400_000;

export class RoundEngine {
  private phase: Phase = "idle";
  private pos: Position = { dir: 1, lev: 10, entryRaw: 0, banked: 0 };
  private stake = 0;
  private startMs = 0;
  private maxSec = CONFIG.MAXSEC;
  private borrowBpsPerDay = 0;
  private segmentStartMs = 0;
  private reason?: SettleReason;
  private finalEquity = 1;

  getPhase(): Phase {
    return this.phase;
  }

  launch(p: LaunchParams): void {
    this.phase = "live";
    this.pos = { dir: p.dir, lev: p.lev, entryRaw: p.entryRaw, banked: p.banked ?? 0 };
    this.stake = p.stake;
    this.startMs = p.startMs;
    this.maxSec = p.maxSec ?? CONFIG.MAXSEC;
    this.borrowBpsPerDay = Math.max(0, p.borrowBpsPerDay ?? 0);
    this.segmentStartMs = p.startMs;
    this.reason = undefined;
    this.finalEquity = 1;
  }

  /** realize the current segment and re-anchor; called when the throttle moves mid-run */
  setLeverage(newLev: number, price: number, nowMs = this.segmentStartMs): void {
    if (this.phase !== "live") return;
    if (newLev === this.pos.lev) return;
    const realized = rebank(this.pos, price);
    this.pos = { ...realized, banked: realized.banked - this.segmentFee(nowMs), lev: newLev };
    this.segmentStartMs = nowMs;
  }

  /** flip direction mid-run (Clown Car lane-bet): realize the current segment + re-anchor */
  setDir(newDir: Dir, price: number, nowMs = this.segmentStartMs): void {
    if (this.phase !== "live") return;
    if (newDir === this.pos.dir) return;
    const realized = rebank(this.pos, price);
    this.pos = { ...realized, banked: realized.banked - this.segmentFee(nowMs), dir: newDir };
    this.segmentStartMs = nowMs;
  }

  /** advance the round; auto-settles on liq/cap/time */
  tick(price: number, nowMs: number): Snapshot {
    if (this.phase !== "live") return this.snapshot(price, nowMs);
    const equity = this.liveEquity(price, nowMs);
    if (equity <= CONFIG.LIQ) return this.finish("liquidated", "liq", 0);
    if (equity >= CONFIG.CAP) return this.finish("settled", "cap", CONFIG.CAP);
    if (Number.isFinite(this.maxSec) && (nowMs - this.startMs) / 1000 >= this.maxSec)
      return this.finish("settled", "time", equity);
    return this.snapshot(price, nowMs);
  }

  cashout(price: number, nowMs: number): Snapshot {
    if (this.phase !== "live") return this.snapshot(price, nowMs);
    return this.finish("settled", "cashout", this.liveEquity(price, nowMs));
  }

  /** add an equity bonus to banked gains (e.g. from collecting a pickup); live only */
  addBonus(amount: number): void {
    if (this.phase !== "live") return;
    this.pos = { ...this.pos, banked: this.pos.banked + amount };
  }

  private finish(phase: Phase, reason: SettleReason, equity: number): Snapshot {
    this.phase = phase;
    this.reason = reason;
    this.finalEquity = equity;
    return {
      phase,
      equity,
      payout: payoutOf(this.stake, equity, CONFIG.EDGE),
      buffer: bufferOf(equity, CONFIG.LIQ),
      banked: this.pos.banked,
      lev: this.pos.lev,
      reason,
    };
  }

  private segmentFee(nowMs: number): number {
    const elapsedMs = Math.max(0, nowMs - this.segmentStartMs);
    return this.pos.lev * this.borrowBpsPerDay / 10_000 * elapsedMs / DAY_MS;
  }

  private liveEquity(price: number, nowMs: number): number {
    return Math.max(0, equityOf(this.pos, price) - this.segmentFee(nowMs));
  }

  snapshot(price: number, nowMs: number): Snapshot {
    if (this.phase === "idle")
      return { phase: "idle", equity: 1, payout: 0, buffer: 1, banked: 0, lev: this.pos.lev };
    const equity = this.phase === "live" ? this.liveEquity(price, nowMs) : this.finalEquity;
    return {
      phase: this.phase,
      equity,
      payout: payoutOf(this.stake, equity, CONFIG.EDGE),
      buffer: bufferOf(equity, CONFIG.LIQ),
      banked: this.pos.banked,
      lev: this.pos.lev,
      reason: this.reason,
    };
  }
}
