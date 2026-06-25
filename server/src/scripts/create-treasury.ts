// Provision the treasury (vault) wallet: a Privy Solana server wallet. Privy custodies the key —
// it receives deposits (address only, no signing) and later signs withdrawals. Idempotent: prints
// the existing wallet if TREASURY_WALLET_ID/TREASURY_OWNER_PUBKEY are already set in server/.env.
import "dotenv/config";
import { PrivyClient } from "@privy-io/node";

async function main(): Promise<void> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    console.error("missing PRIVY_APP_ID / PRIVY_APP_SECRET in server/.env");
    process.exit(1);
  }
  if (process.env.TREASURY_WALLET_ID?.trim() && process.env.TREASURY_OWNER_PUBKEY?.trim()) {
    console.log(`reusing treasury wallet ${process.env.TREASURY_WALLET_ID} (${process.env.TREASURY_OWNER_PUBKEY})`);
    return;
  }
  const client = new PrivyClient({ appId, appSecret });
  const w = await client.wallets().create({ chain_type: "solana" });
  console.log("=== TREASURY (vault) WALLET CREATED — add these to server/.env ===");
  console.log(`TREASURY_WALLET_ID=${w.id}`);
  console.log(`TREASURY_OWNER_PUBKEY=${w.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
