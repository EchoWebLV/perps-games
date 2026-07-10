import type { Asset, Dir, TradeOutcome } from "./api";
import type { TradeCompletion, TradeHistoryRecorder } from "./trade-history-recorder";

export interface ConfirmedTradeOpen {
  asset: Asset;
  dir: Dir;
  lev: number;
  stakeBase: number;
  entryPrice: number;
  entryTs?: number;
}

export interface AuthoritativeTradeSettlement {
  outcome: number;
  outcomeName: string;
  payout: bigint;
  exitHuman: number;
}

export interface TradeHistoryBridge {
  begin(opened: ConfirmedTradeOpen): void;
  settle(result: AuthoritativeTradeSettlement): void;
  flush(): Promise<void>;
}

const OUTCOMES = ["cashout", "cap", "liq", "time"] as const;

function settlementOutcome(outcome: number, outcomeName: string): TradeOutcome | null {
  const numeric = Number.isInteger(outcome) ? OUTCOMES[outcome] : undefined;
  const named = OUTCOMES.find((candidate) => candidate === outcomeName);
  if (numeric && named && numeric !== named) return null;
  return named ?? numeric ?? null;
}

function validOpen(opened: ConfirmedTradeOpen): boolean {
  return (opened.asset === "BTC" || opened.asset === "ETH" || opened.asset === "SOL")
    && (opened.dir === 1 || opened.dir === -1)
    && Number.isInteger(opened.lev)
    && opened.lev >= 1
    && opened.lev <= 3000
    && Number.isSafeInteger(opened.stakeBase)
    && opened.stakeBase > 0
    && Number.isFinite(opened.entryPrice)
    && opened.entryPrice > 0;
}

export function createTradeHistoryBridge(
  recorder: TradeHistoryRecorder,
  options: {
    now?: () => number;
    warn?: (message: string, cause?: unknown) => void;
  } = {},
): TradeHistoryBridge {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string, cause?: unknown) => console.warn(message, cause));
  let active = false;
  let pendingCompletion: TradeCompletion | null = null;
  let flushing: Promise<void> | null = null;

  const flushRecorder = async (): Promise<void> => {
    try {
      await recorder.flush();
    } catch (error) {
      warn("[trade-history] flush failed", error);
    }
  };

  const retryCompletion = (): boolean => {
    if (!pendingCompletion) return false;
    try {
      recorder.complete(pendingCompletion);
      pendingCompletion = null;
      active = false;
      return true;
    } catch (error) {
      warn("[trade-history] completion failed", error);
      return false;
    }
  };

  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    let task!: Promise<void>;
    task = (async () => {
      // A retained completion can be blocked by an older saturated queue order. Drain
      // that queue first, then retry the completion and upload the newly queued record.
      await flushRecorder();
      if (pendingCompletion && retryCompletion()) await flushRecorder();
    })().finally(() => {
      if (flushing === task) flushing = null;
    });
    flushing = task;
    return task;
  };

  return {
    begin(opened) {
      if (pendingCompletion && !retryCompletion()) {
        warn("[trade-history] skipped confirmed open while completion is pending");
        return;
      }
      active = false;
      if (!validOpen(opened)) {
        warn("[trade-history] skipped invalid confirmed open");
        return;
      }

      try {
        const openedAtMs = typeof opened.entryTs === "number"
          && Number.isFinite(opened.entryTs)
          && opened.entryTs > 0
          ? opened.entryTs * 1000
          : now();
        const openedAt = new Date(openedAtMs).toISOString();
        recorder.begin({
          asset: opened.asset,
          dir: opened.dir,
          lev: opened.lev,
          stakeBase: opened.stakeBase,
          entryPrice: opened.entryPrice,
          openedAt,
        });
        active = true;
      } catch (error) {
        warn("[trade-history] begin failed", error);
      }
    },

    settle(result) {
      if (pendingCompletion) {
        void flush();
        return;
      }
      const shouldComplete = active;

      if (shouldComplete) {
        const outcome = settlementOutcome(result.outcome, result.outcomeName);
        const payout = result.payout;
        const payoutIsValid = typeof payout === "bigint"
          && payout >= 0n
          && payout <= BigInt(Number.MAX_SAFE_INTEGER);
        if (!outcome
          || !payoutIsValid
          || !Number.isFinite(result.exitHuman)
          || result.exitHuman <= 0) {
          warn("[trade-history] skipped invalid settlement");
          active = false;
        } else {
          pendingCompletion = {
            outcome,
            payoutBase: Number(payout),
            exitPrice: result.exitHuman,
          };
          retryCompletion();
        }
      }

      void flush();
    },

    flush,
  };
}
