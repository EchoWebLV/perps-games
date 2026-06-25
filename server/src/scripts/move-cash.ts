// Reallocate cash between two accounts (keeps total liabilities + solvency unchanged). Operator/support
// tool. Usage:  DATABASE_URL=… npx tsx src/scripts/move-cash.ts <fromExternalId> <toExternalId> <cents>
import "dotenv/config";
import { createDb } from "../db/client.js";
import { makeLedger } from "../services/ledger.js";
import { makeUsers } from "../services/users.js";

async function main(): Promise<void> {
  const [fromExt, toExt, centsStr] = process.argv.slice(2);
  const dbUrl = process.env.DATABASE_URL;
  if (!fromExt || !toExt || !centsStr || !dbUrl) { console.error("usage: DATABASE_URL=… move-cash <fromExt> <toExt> <cents>"); process.exit(1); }
  const cents = parseInt(centsStr, 10);

  const raw = createDb(dbUrl);
  const users = makeUsers(raw.db);
  const ledger = makeLedger(raw.db);
  const from = await users.upsertByExternalId(fromExt);
  const to = await users.upsertByExternalId(toExt);
  const tag = `realloc-${from.id.slice(0, 8)}-${to.id.slice(0, 8)}`;

  const ok = await ledger.debit(from.id, "cash", cents, "admin_realloc", `${tag}-out`);
  if (!ok) { console.error(`✗ ${fromExt} has insufficient cash for ${cents}c`); await raw.close(); process.exit(2); }
  await ledger.credit(to.id, "cash", cents, "admin_realloc", `${tag}-in`);

  console.log(`moved ${cents}c cash: ${fromExt} → ${toExt}`);
  console.log(`  ${fromExt} cash: ${await ledger.balance(from.id, "cash")}`);
  console.log(`  ${toExt} cash: ${await ledger.balance(to.id, "cash")}`);
  await raw.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
