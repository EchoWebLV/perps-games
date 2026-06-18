import { CONFIG } from "./config";
import type { Dir, Phase, SettleReason, Position, Snapshot } from "./types";
import { equityOf, payoutOf, bufferOf, rebank } from "./economics";

export interface LaunchParams {
  dir: Dir;
  lev: number;
  stake: number;
  entryRaw: number;
  startMs: number;
}

export class RoundEngine {
  private phase: Phase = "idle";
  private pos: Position = { dir: 1, lev: 10, entryRaw: 0, banked: 0 };
  private stake = 0;
  private startMs = 0;
  private reason?: SettleReason;
  private finalEquity = 1;

  getPhase(): Phase {
    return this.phase;
  }

  launch(p: LaunchParams): void {
    this.phase = "live";
    this.pos = { dir: p.dir, lev: p.lev, entryRaw: p.entryRaw, banked: 0 };
    this.stake = p.stake;
    this.startMs = p.startMs;
    this.reason = undefined;
    this.finalEquity = 1;
  }

  /** realize the current segment and re-anchor; called when the throttle moves mid-run */
  setLeverage(newLev: number, price: number): void {
    if (this.phase !== "live") return;
    if (newLev === this.pos.lev) return;
    this.pos = { ...rebank(this.pos, price), lev: newLev };
  }

  /** advance the round; auto-settles on liq/cap/time */
  tick(price: number, nowMs: number): Snapshot {
    if (this.phase !== "live") return this.snapshot(price, nowMs);
    const equity = equityOf(this.pos, price);
    if (equity <= CONFIG.LIQ) return this.finish("liquidated", "liq", 0);
    if (equity >= CONFIG.CAP) return this.finish("settled", "cap", CONFIG.CAP);
    if ((nowMs - this.startMs) / 1000 >= CONFIG.MAXSEC)
      return this.finish("settled", "time", equity);
    return this.snapshot(price, nowMs);
  }

  cashout(price: number, nowMs: number): Snapshot {
    if (this.phase !== "live") return this.snapshot(price, nowMs);
    return this.finish("settled", "cashout", equityOf(this.pos, price));
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

  snapshot(price: number, _nowMs: number): Snapshot {
    if (this.phase === "idle")
      return { phase: "idle", equity: 1, payout: 0, buffer: 1, banked: 0, lev: this.pos.lev };
    const equity = this.phase === "live" ? equityOf(this.pos, price) : this.finalEquity;
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
