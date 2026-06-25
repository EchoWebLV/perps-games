/**
 * Poll loop that drives the per-id withdraw confirmer over all `sent` withdrawals
 * (mirrors makeDepositConfirmer's start/stop shape). One slow/failed id never blocks
 * the others: each confirm is awaited in isolation and its rejection is swallowed
 * (the row stays `sent` and is retried next tick).
 */
export interface WithdrawConfirmLoopDeps {
  /** Ids of withdrawals currently in status `sent`. */
  listSentIds: () => Promise<string[]>;
  /** The confirmer from makeWithdrawConfirmer. */
  confirmer: { confirm: (id: string) => Promise<"confirmed" | "reversed" | "needs_review" | "skip"> };
  pollMs: number;
}

export function makeWithdrawConfirmLoop(deps: WithdrawConfirmLoopDeps) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<void> {
    // A prior tick may still be in flight when the interval fires again (many `sent` rows ×
    // per-id RPC latency > pollMs). Skip rather than run overlapping ticks that re-query the
    // same rows and waste RPC. Correctness doesn't depend on this (the credit + status writes
    // are idempotent), but it keeps the loop from hammering the chain.
    if (running) return;
    running = true;
    try {
      const ids = await deps.listSentIds();
      for (const id of ids) {
        await deps.confirmer.confirm(id).catch(() => {});
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), deps.pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
