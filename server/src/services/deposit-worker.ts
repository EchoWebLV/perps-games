import { eq } from "drizzle-orm";
import { depositCursors } from "../db/schema.js";
import type { Deposits, InboundTransfer } from "./deposits.js";
import type { DepositSource } from "../solana/deposit-source.js";

/** Durable poll cursor for the confirmer: the newest signature processed so far, per treasury ATA. */
export interface DepositCursorStore {
  get(treasuryAta: string): Promise<string | undefined>;
  set(treasuryAta: string, sig: string): Promise<void>;
}

/** DB-backed cursor store (deposit_cursors table), so the confirmer resumes across restarts. */
export function makeDbDepositCursorStore(db: any): DepositCursorStore {
  return {
    async get(treasuryAta) {
      const rows = await db.select().from(depositCursors).where(eq(depositCursors.treasuryAta, treasuryAta)).limit(1);
      return rows[0]?.lastSig ?? undefined;
    },
    async set(treasuryAta, sig) {
      await db
        .insert(depositCursors)
        .values({ treasuryAta, lastSig: sig, updatedAt: new Date() })
        .onConflictDoUpdate({ target: depositCursors.treasuryAta, set: { lastSig: sig, updatedAt: new Date() } });
    },
  };
}

export interface DepositConfirmerOpts {
  deposits: Deposits;
  source: DepositSource;
  store: DepositCursorStore;
  treasuryAta: string;
  pollMs: number;
  /** signatures per RPC page (default 100). */
  pageLimit?: number;
}

export function makeDepositConfirmer(opts: DepositConfirmerOpts) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const limit = opts.pageLimit ?? 100;

  async function tick(): Promise<void> {
    // read the cursor from the durable store each tick — the store is the source of truth, so a
    // restart naturally resumes from the last persisted position.
    const cursor = await opts.store.get(opts.treasuryAta);

    const pages: InboundTransfer[][] = [];
    let beforeSig: string | undefined;
    let newestSig: string | undefined; // newest raw signature of the whole scan = newest of the first page
    // Page backwards from newest toward the cursor until a short page (or no progress). A burst larger
    // than one page — even if padded with dust — can't push legitimate deposits out of the window.
    for (;;) {
      const page = await opts.source.fetchInbound({ treasuryAta: opts.treasuryAta, untilSig: cursor, beforeSig, limit });
      if (page.newestSig && !newestSig) newestSig = page.newestSig;
      if (page.transfers.length) pages.push(page.transfers);
      if (!page.full || !page.oldestSig || page.oldestSig === beforeSig) break; // reached the cursor / end / no progress
      beforeSig = page.oldestSig;
    }
    if (!newestSig) return; // nothing new since the cursor

    // Process oldest→newest across ALL pages so a crash mid-scan leaves the cursor behind, never ahead
    // (recordInbound is idempotent, so a reprocessed signature never double-credits). `pages` are
    // newest-first (page 0 newest); flat() is global newest→oldest, reverse() gives oldest→newest.
    for (const t of pages.flat().reverse()) await opts.deposits.recordInbound(t);

    // advance + PERSIST the cursor only AFTER every transfer is processed (crash-safety).
    await opts.store.set(opts.treasuryAta, newestSig);
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
