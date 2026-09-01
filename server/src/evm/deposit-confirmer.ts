import type { DepositCursorStore } from "../services/deposit-worker.js";
import type { InboundTransfer } from "../services/deposits.js";
import type { EvmDepositSource } from "./deposit-source.js";

export interface EvmDepositConfirmerOpts {
  deposits: { recordInbound(t: InboundTransfer): Promise<unknown> };
  source: Pick<EvmDepositSource, "fetchInboundRange">;
  /**
   * Reuses the Solana rail's `deposit_cursors` table verbatim: the key column (`treasuryAta`) holds
   * the lowercased treasury ADDRESS, and the value column (`lastSig`) holds the stringified last
   * scanned BLOCK NUMBER. One row per treasury, so the two rails never collide.
   */
  store: DepositCursorStore;
  treasury: string;
  pollMs: number;
  /** Where a fresh deploy starts scanning, so the first tick is not a walk from genesis. */
  startBlock: bigint;
}

export function makeEvmDepositConfirmer(opts: EvmDepositConfirmerOpts) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const key = opts.treasury.toLowerCase();

  async function tick(): Promise<void> {
    // Read the cursor from the durable store each tick — the store is the source of truth, so a
    // restart naturally resumes from the last persisted position.
    const stored = await opts.store.get(key);
    const fromBlock = stored !== undefined ? BigInt(stored) + 1n : opts.startBlock;

    const page = await opts.source.fetchInboundRange({ fromBlock });
    // Range ended before it began = the safe head has not reached fromBlock. Hold the cursor: moving
    // it here would skip blocks that were never scanned.
    if (page.toBlock < fromBlock) return;

    // Process oldest→newest so a crash mid-range leaves the cursor BEHIND, never ahead
    // (recordInbound is idempotent on txSig, so a reprocessed transfer never double-credits).
    for (const t of [...page.transfers].sort((a, b) => a.slot - b.slot)) {
      await opts.deposits.recordInbound(t);
    }

    // Advance + PERSIST the cursor only AFTER every transfer is processed (crash-safety): a throw
    // above leaves the old cursor in place and the whole range is rescanned next tick.
    await opts.store.set(key, page.toBlock.toString());
  }

  return {
    tick,
    start() {
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), opts.pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
