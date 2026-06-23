import { eq } from "drizzle-orm";
import { deposits, depositSources, users } from "../db/schema.js";
import { baseUnitsToCents } from "../money/usdc.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";
import type { Ledger } from "./ledger.js";

export interface InboundTransfer {
  txSig: string;
  slot: number;
  finalized: boolean;
  mint: string;
  tokenProgram: string;
  destAta: string;
  sourceOwner: string;
  amountBaseUnits: bigint;
}

export interface DepositsConfig {
  usdcMint: string;
  treasuryAta: string;
  minCents: number;
  maxCents: number;
}

export type DepositOutcome =
  | { status: "credited"; userId: string; amountCents: number }
  | { status: "duplicate" }
  | { status: "quarantine"; reason: string };

export function makeDeposits(db: any, ledger: Ledger, cfg: DepositsConfig) {
  async function quarantine(t: InboundTransfer, reason: string, cents: number | null, userId: string | null): Promise<DepositOutcome> {
    await db.insert(deposits).values({
      txSig: t.txSig, userId, amountBaseUnits: t.amountBaseUnits.toString(), amountCents: cents,
      mint: t.mint, sourceOwner: t.sourceOwner, destAta: t.destAta, slot: t.slot,
      status: "quarantine", reason,
    }).onConflictDoNothing();
    return { status: "quarantine", reason };
  }

  return {
    async recordInbound(t: InboundTransfer): Promise<DepositOutcome> {
      if (!t.finalized) return { status: "quarantine", reason: "not_finalized" };
      if (t.destAta !== cfg.treasuryAta) return quarantine(t, "wrong_dest", null, null);
      if (t.mint !== cfg.usdcMint) return quarantine(t, "wrong_mint", null, null);
      if (t.tokenProgram !== LEGACY_TOKEN_PROGRAM) return quarantine(t, "wrong_program", null, null);

      let cents: number;
      try { cents = Number(baseUnitsToCents(t.amountBaseUnits)); }
      catch { return quarantine(t, "sub_cent_dust", null, null); }
      if (cents < cfg.minCents || cents > cfg.maxCents) return quarantine(t, "out_of_bounds", cents, null);

      const found = await db.select().from(users).where(eq(users.walletPublicKey, t.sourceOwner)).limit(1);
      const user = found[0];
      if (!user) return quarantine(t, "unknown_source", cents, null);

      const bound = await db.select().from(depositSources).where(eq(depositSources.sourceWallet, t.sourceOwner)).limit(1);
      if (bound[0] && bound[0].userId !== user.id) return quarantine(t, "source_bound_other", cents, user.id);

      return db.transaction(async (tx: any) => {
        const ins = await tx.insert(deposits).values({
          txSig: t.txSig, userId: user.id, amountBaseUnits: t.amountBaseUnits.toString(), amountCents: cents,
          mint: t.mint, sourceOwner: t.sourceOwner, destAta: t.destAta, slot: t.slot,
          status: "credited", reason: null,
        }).onConflictDoNothing().returning({ id: deposits.id });
        if (ins.length === 0) return { status: "duplicate" } as DepositOutcome;
        await ledger.creditOn(tx, user.id, "cash", cents, "deposit", t.txSig);
        await tx.insert(depositSources).values({
          userId: user.id, sourceWallet: t.sourceOwner, firstSeenTxSig: t.txSig,
        }).onConflictDoNothing();
        return { status: "credited", userId: user.id, amountCents: cents } as DepositOutcome;
      });
    },
  };
}

export type Deposits = ReturnType<typeof makeDeposits>;
