// Operator read-out: vault on-chain balances (USDC + SOL-for-gas) vs the ledger's user liabilities,
// and whether the house is solvent. Read-only — moves nothing. Run:
//   DATABASE_URL=postgres://localhost:5432/perps_dev npx tsx src/scripts/vault-status.ts
import "dotenv/config";
import { createSolanaRpc, address } from "@solana/kit";
import { createDb } from "../db/client.js";
import { makeReconcile } from "../services/reconcile.js";
import { makeUsers } from "../services/users.js";
import { ensureHouseUserId } from "../services/house.js";
import { makeRpcDepositSource } from "../solana/deposit-source.js";

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const ata = process.env.TREASURY_USDC_ATA;
  const owner = process.env.TREASURY_OWNER_PUBKEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!rpcUrl || !ata || !owner) { console.error("set SOLANA_RPC_URL / TREASURY_USDC_ATA / TREASURY_OWNER_PUBKEY"); process.exit(1); }
  if (!dbUrl) { console.error("pass DATABASE_URL=… "); process.exit(1); }

  const source = makeRpcDepositSource(rpcUrl);
  const usdcBase = await source.readTreasuryBaseUnits(ata).catch(() => 0n); // 0 until the ATA exists
  const rpc = createSolanaRpc(rpcUrl);
  const solLamports = await rpc.getBalance(address(owner)).send().then((r) => r.value).catch(() => 0n);

  const raw = createDb(dbUrl);
  const houseUserId = await ensureHouseUserId(makeUsers(raw.db));
  const recon = makeReconcile(raw.db, async () => usdcBase, houseUserId);
  const s = await recon.solvency();
  await raw.close();

  const usd = (cents: number) => "$" + (cents / 100).toFixed(2);
  console.log("=== VAULT STATUS ===");
  console.log(`  owner            : ${owner}`);
  console.log(`  USDC token acct  : ${ata}`);
  console.log(`  vault USDC       : ${(Number(usdcBase) / 1e6).toFixed(6)} USDC`);
  console.log(`  vault SOL (gas)  : ${(Number(solLamports) / 1e9).toFixed(6)} SOL  ${solLamports === 0n ? "(needs ~0.01 to withdraw)" : ""}`);
  console.log(`  player liabilities : ${usd(s.liabilitiesCents)}  (cash owed to players, house excluded)`);
  console.log(`  house bankroll     : ${usd(s.bankrollCents)}  ${s.bankrollCents < 0 ? "✗ UNDERWATER — fund it" : ""}`);
  console.log(`  on-chain (cents)   : ${usd(s.onChainCents)}`);
  console.log(`  solvency           : ${s.solvent ? "OK ✓ (vault ≥ player liabilities)" : "DEFICIT " + usd(s.deficitCents) + " ✗"}`);
  console.log(`  conservation       : ${s.conserved ? "OK ✓ (vault == players + house)" : "MISMATCH ✗ (untracked funds?)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
