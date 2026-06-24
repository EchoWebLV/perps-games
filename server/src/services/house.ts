import type { Users } from "./users.js";

/**
 * The reserved house counterparty. Round P&L flows to/from its `cash` balance: a player's
 * stake escrows INTO the house on open, the house pays the payout OUT on close. The bankroll
 * is just this account's cash balance — it may run negative when under-capitalized. It never
 * authenticates (no `dev:`/`privy:` auth prefix) and never opens rounds.
 */
export const HOUSE_EXTERNAL_ID = "system:house";

/** Resolve (creating on first call) the reserved house account; returns its userId. */
export async function ensureHouseUserId(users: Users): Promise<string> {
  return (await users.upsertByExternalId(HOUSE_EXTERNAL_ID)).id;
}
