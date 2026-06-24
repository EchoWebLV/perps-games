// One-time bootstrap: re-label an existing player's cash balance as the house's OPENING bankroll.
// Ledger-only — moves NO on-chain USDC; the vault balance and overall solvency are unchanged.
// It only changes WHO owns the funds (player → system:house). Idempotent per source account
// (a second run for the same <fromExternalId> is a no-op, so you can't accidentally double-seed).
//   DATABASE_URL=postgres://localhost:5432/perps_dev npx tsx src/scripts/seed-house.ts <fromExternalId> <cents>
import "dotenv/config";
import { createDb } from "../db/client.js";
import { makeLedger } from "../services/ledger.js";
import { makeUsers } from "../services/users.js";
import { ensureHouseUserId, seedHouseFromAccount, HOUSE_EXTERNAL_ID } from "../services/house.js";

async function main(): Promise<void> {
  const [fromExt, centsStr] = process.argv.slice(2);
  const dbUrl = process.env.DATABASE_URL;
  if (!fromExt || !centsStr || !dbUrl) {
    console.error("usage: DATABASE_URL=… npx tsx src/scripts/seed-house.ts <fromExternalId> <cents>");
    process.exit(1);
  }
  const cents = parseInt(centsStr, 10);
  if (!Number.isInteger(cents) || cents <= 0) { console.error("cents must be a positive integer"); process.exit(1); }

  const raw = createDb(dbUrl);
  const users = makeUsers(raw.db);
  const ledger = makeLedger(raw.db);
  const from = await users.upsertByExternalId(fromExt);
  const houseUserId = await ensureHouseUserId(users);
  if (from.id === houseUserId) { console.error("✗ from and house are the same account"); await raw.close(); process.exit(2); }

  // idempotent per (source account): re-running with the same <fromExternalId> is a no-op.
  // Both legs post atomically in one tx (see seedHouseFromAccount) — a crash can't burn one side.
  const ref = `house-seed-${from.id.slice(0, 8)}`;
  const outcome = await seedHouseFromAccount(raw.db, ledger, from.id, houseUserId, cents, ref).catch((e) => {
    console.error(`✗ ${e?.message === "insufficient balance" ? `${fromExt} has insufficient cash for ${cents}c` : e?.message}`);
    return null;
  });
  if (outcome === null) { await raw.close(); process.exit(3); }
  if (outcome === "noop") {
    console.error(`✗ ${fromExt} was already seeded (idempotent no-op) — nothing moved`);
    await raw.close();
    process.exit(3);
  }

  console.log(`re-labeled ${cents}c cash as house bankroll: ${fromExt} → ${HOUSE_EXTERNAL_ID}`);
  console.log(`  ${fromExt} cash : ${await ledger.balance(from.id, "cash")}`);
  console.log(`  house bankroll  : ${await ledger.balance(houseUserId, "cash")}`);
  await raw.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
