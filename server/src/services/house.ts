import type { Users } from "./users.js";
import type { Ledger } from "./ledger.js";

/**
 * The reserved house counterparty. Round P&L flows to/from its `cash` balance: a player's
 * stake escrows INTO the house on open, the house pays the payout OUT on close. The bankroll
 * is just this account's cash balance — it may run negative when under-capitalized. It never
 * authenticates (no `dev:` or provider-auth prefix) and never opens rounds.
 */
export const HOUSE_EXTERNAL_ID = "system:house";

/** Resolve (creating on first call) the reserved house account; returns its userId. */
export async function ensureHouseUserId(users: Users): Promise<string> {
  return (await users.upsertByExternalId(HOUSE_EXTERNAL_ID)).id;
}

/**
 * Re-label a player's cash as house bankroll: debit the player, credit the house — atomically,
 * in ONE transaction, so a crash can never burn the debit without the matching credit. Idempotent
 * on `ref`: a replay finds the debit leg already posted and returns "noop" (both legs were committed
 * together the first time, so there is never a half-applied state to repair). Throws on insufficient
 * cash (the debit leg's balance check), rolling the whole tx back.
 */
export async function seedHouseFromAccount(
  db: any,
  ledger: Ledger,
  fromUserId: string,
  houseUserId: string,
  cents: number,
  ref: string,
): Promise<"moved" | "noop"> {
  return db.transaction(async (tx: any) => {
    const debited = await ledger.debitOn(tx, fromUserId, "cash", cents, "house_seed", `${ref}-out`);
    if (!debited) return "noop"; // idempotent replay — already seeded from this source
    await ledger.creditOn(tx, houseUserId, "cash", cents, "house_seed", `${ref}-in`);
    return "moved";
  });
}
