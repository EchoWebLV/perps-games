import type { Deposits } from "./deposits.js";
import type { DepositSource } from "../solana/deposit-source.js";

export interface DepositConfirmerOpts {
  deposits: Deposits;
  source: DepositSource;
  treasuryAta: string;
  pollMs: number;
}

export function makeDepositConfirmer(opts: DepositConfirmerOpts) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor: string | undefined; // newest processed signature

  async function tick(): Promise<void> {
    const batch = await opts.source.fetchInbound({ treasuryAta: opts.treasuryAta, untilSig: cursor });
    if (batch.length === 0) return;
    // process oldest→newest so a crash mid-batch leaves the cursor behind, never ahead
    for (const t of [...batch].reverse()) await opts.deposits.recordInbound(t);
    cursor = batch[0].txSig; // batch[0] is newest (source returns newest-first)
  }

  return {
    tick,
    start() {
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), opts.pollMs);
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
