// Bind a deposit source wallet to a user account (set-once), so deposits FROM that wallet are
// attributed + credited instead of quarantined. Usage:
//   DATABASE_URL=… npx tsx src/scripts/bind-wallet.ts <externalId> <walletAddress>
import "dotenv/config";
import { createDb } from "../db/client.js";
import { makeUsers } from "../services/users.js";

// Address shapes per chain family — mirrors auth/wallet-binding.ts. EVM addresses are stored
// lowercased so bound-wallet == deposit-source `from` compares exactly.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function main(): Promise<void> {
  const [externalId, rawWallet] = process.argv.slice(2);
  const dbUrl = process.env.DATABASE_URL;
  // Same default as src/env.ts (CHAIN_FAMILY defaults to "evm").
  const family = process.env.CHAIN_FAMILY === "solana" ? "solana" : "evm";
  if (!externalId || !rawWallet) { console.error("usage: bind-wallet <externalId> <walletAddress>"); process.exit(1); }
  if (!dbUrl) { console.error("set DATABASE_URL=…"); process.exit(1); }

  const valid = family === "evm" ? EVM_ADDRESS_RE.test(rawWallet) : SOLANA_ADDRESS_RE.test(rawWallet);
  if (!valid) {
    console.error(
      `✗ invalid wallet address for CHAIN_FAMILY=${family} — expected ` +
        (family === "evm" ? "a 0x-prefixed 40-hex EVM address" : "a base58 Solana address (32–44 chars)") +
        `, got: ${rawWallet}`,
    );
    process.exit(1);
  }
  const wallet = family === "evm" ? rawWallet.toLowerCase() : rawWallet;

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
