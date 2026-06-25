// Bind a deposit source wallet to a user account (set-once), so deposits FROM that wallet are
// attributed + credited instead of quarantined. Usage:
//   DATABASE_URL=… npx tsx src/scripts/bind-wallet.ts <externalId> <walletAddress>
import "dotenv/config";
import { createDb } from "../db/client.js";
import { makeUsers } from "../services/users.js";

async function main(): Promise<void> {
  const [externalId, wallet] = process.argv.slice(2);
  const dbUrl = process.env.DATABASE_URL;
  if (!externalId || !wallet) { console.error("usage: bind-wallet <externalId> <walletAddress>"); process.exit(1); }
  if (!dbUrl) { console.error("set DATABASE_URL=…"); process.exit(1); }

  const raw = createDb(dbUrl);
  const users = makeUsers(raw.db);
  const user = await users.upsertByExternalId(externalId);
  await users.setWalletPublicKey(user.id, wallet);
  const after = await users.get(user.id);
  await raw.close();

  console.log("=== BIND ===");
  console.log(`  externalId      : ${externalId}`);
  console.log(`  userId          : ${user.id}`);
  console.log(`  walletPublicKey : ${after?.walletPublicKey}`);
  if (after?.walletPublicKey !== wallet) {
    console.error("  ✗ BIND FAILED — user already bound to a different wallet (set-once).");
    process.exit(2);
  }
  console.log("  ✓ bound — deposits from this wallet now credit this account.");
}

main().catch((e) => { console.error(e); process.exit(1); });
