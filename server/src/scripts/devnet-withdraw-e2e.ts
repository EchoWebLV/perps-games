/**
 * Devnet end-to-end proof for the self-custody withdraw send-leg (money-rails-3, Task 6).
 *
 * Drives the REAL building blocks against devnet — reserve → approve → sign → send → confirm —
 * and asserts that devnet USDC actually moved treasury → destination and the `cash` ledger
 * reconciled (debited exactly once, never re-credited). No HTTP server needed; it exercises the
 * same services index.ts wires in production.
 *
 * SAFETY: refuses to run unless SOLANA_CLUSTER=devnet and the RPC url is not a mainnet endpoint.
 * It can never touch the mainnet treasury. You fund a THROWAWAY devnet treasury; the script only
 * reads balances and drives the already-built code.
 *
 * Prereqs you provide (all devnet):
 *   - A throwaway treasury keypair (TREASURY_SECRET = JSON byte array or base64), its pubkey
 *     (TREASURY_OWNER_PUBKEY), and its USDC ATA (TREASURY_USDC_ATA) funded with devnet USDC + a
 *     little devnet SOL for gas.
 *   - A destination wallet (DEST_WALLET) that ALREADY has a devnet USDC ATA (the transfer target).
 *   - A Postgres DATABASE_URL (a scratch DB is fine; the script migrates it).
 *
 * Run (from server/), passing devnet values INLINE so they win over any mainnet server/.env:
 *   DATABASE_URL=postgres://localhost:5432/perps_devnet \
 *   SOLANA_CLUSTER=devnet SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   USDC_MINT=<devnet-usdc-mint> TREASURY_USDC_ATA=<devnet-treasury-ata> \
 *   TREASURY_OWNER_PUBKEY=<devnet-treasury-pubkey> TREASURY_SECRET='[...]' \
 *   DEST_WALLET=<devnet-dest-wallet> WITHDRAW_AMOUNT_CENTS=100 \
 *   npx tsx src/scripts/devnet-withdraw-e2e.ts
 *
 * NOTE on re-runs: each run sends WITHDRAW_AMOUNT_CENTS of devnet USDC out and that confirmed
 * amount counts toward the 24h solvency/cap math, so fund the treasury with a few× the amount and
 * use a fresh treasury (or wait out the window) for many repeats. The failed→reversed path is
 * covered by the unit test (withdraw-worker.test.ts) — it is intentionally NOT forced here, because
 * preflight would reject a bad transfer before broadcast rather than landing a failed tx on-chain.
 */
import "dotenv/config";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { depositSources } from "../db/schema.js";
import { makeUsers } from "../services/users.js";
import { makeLedger } from "../services/ledger.js";
import { makeWithdrawals } from "../services/withdrawals.js";
import { makeWithdrawProcessor, makeWithdrawConfirmer } from "../services/withdraw-worker.js";
import { makeRpcDepositSource } from "../solana/deposit-source.js";
import { makeRpcBlockhash } from "../services/deposit-tx.js";
import { makeTreasuryWithdrawSigner } from "../solana/treasury-signer.js";
import { makeRpcChainStatusReader } from "../solana/chain-status.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";
import { centsToBaseUnits } from "../money/usdc.js";

const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EXTERNAL_ID = "devnet-withdraw-e2e";
const CONFIRM_TIMEOUT_MS = 150_000;
const CONFIRM_POLL_MS = 3_000;

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`✗ missing required env: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function fail(msg: string): never {
  console.error(`\n✗ FAIL — ${msg}`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // ---- SAFETY: devnet only, never mainnet ----
  const cluster = process.env.SOLANA_CLUSTER ?? "";
  const rpcUrl = req("SOLANA_RPC_URL");
  if (cluster !== "devnet") fail(`SOLANA_CLUSTER must be 'devnet' for this harness (got '${cluster || "unset"}')`);
  if (/mainnet/i.test(rpcUrl)) fail(`SOLANA_RPC_URL looks like mainnet ('${rpcUrl}') — refusing to run`);

  const dbUrl = req("DATABASE_URL");
  const usdcMint = req("USDC_MINT");
  const treasuryUsdcAta = req("TREASURY_USDC_ATA");
  const treasuryOwner = req("TREASURY_OWNER_PUBKEY");
  const treasurySecret = req("TREASURY_SECRET");
  const destWallet = req("DEST_WALLET");
  const amountCents = Number(process.env.WITHDRAW_AMOUNT_CENTS ?? "100");
  if (!Number.isInteger(amountCents) || amountCents <= 0) fail("WITHDRAW_AMOUNT_CENTS must be a positive integer");
  if (usdcMint === MAINNET_USDC_MINT) fail("USDC_MINT is the mainnet USDC mint — set the devnet mint");

  console.log("=== devnet withdraw send-leg e2e ===");
  console.log(`  cluster   : ${cluster}  (${rpcUrl})`);
  console.log(`  treasury  : ${treasuryOwner}  ata=${treasuryUsdcAta}`);
  console.log(`  dest      : ${destWallet}`);
  console.log(`  amount    : ${amountCents}c\n`);

  const raw = createDb(dbUrl);
  await raw.runMigrations();
  const db = raw.db;
  const users = makeUsers(db);
  const ledger = makeLedger(db);

  try {
    // ---- 1. test user bound to the destination wallet ----
    const user = await users.upsertByExternalId(EXTERNAL_ID);
    await users.setWalletPublicKey(user.id, destWallet);
    const bound = await users.get(user.id);
    if (bound?.walletPublicKey !== destWallet) {
      fail(`user '${EXTERNAL_ID}' is set-once bound to a different wallet (${bound?.walletPublicKey}); use a fresh DB or external id`);
    }

    // withdraw reserve reads the dest from deposit_sources (NOT users.wallet) — ensure a row exists.
    const existingSrc = await db.select().from(depositSources).where(eq(depositSources.userId, user.id)).limit(1);
    if (existingSrc[0]) {
      if (existingSrc[0].sourceWallet !== destWallet) {
        fail(`deposit_sources for this user points at ${existingSrc[0].sourceWallet}, not DEST_WALLET`);
      }
    } else {
      try {
        await db.insert(depositSources).values({
          userId: user.id,
          sourceWallet: destWallet,
          firstSeenTxSig: "devnet-e2e-harness",
        });
      } catch (e: any) {
        if (/unique|duplicate/i.test(String(e?.message ?? e))) {
          fail(`DEST_WALLET ${destWallet} is already bound to a different account (source_wallet is globally unique)`);
        }
        throw e;
      }
    }

    // ---- 2. seed withdrawable cash (mirrors a prior deposit's liability) ----
    await ledger.credit(user.id, "cash", amountCents, "devnet_e2e_seed", crypto.randomUUID());
    const cashAfterSeed = await ledger.balance(user.id, "cash");
    console.log(`seeded cash → balance ${cashAfterSeed}c`);

    // ---- 3. build the REAL send-leg (same wiring as index.ts) ----
    const source = makeRpcDepositSource(rpcUrl);
    const treasurySigner = await makeTreasuryWithdrawSigner(treasurySecret, {
      rpcUrl,
      treasuryUsdcAta,
      usdcMint,
      getLatestBlockhash: makeRpcBlockhash(rpcUrl),
    });
    if (treasurySigner.address !== treasuryOwner) {
      fail(`derived signer address ${treasurySigner.address} != TREASURY_OWNER_PUBKEY ${treasuryOwner}`);
    }
    const withdrawals = makeWithdrawals(
      db,
      ledger,
      // generous caps + no hold so the harness isn't blocked by policy; the on-chain move is the point.
      { minCents: 1, maxCents: 1_000_000, userDailyCapCents: 1_000_000, globalDailyCapCents: 1_000_000, holdHours: 0, quorumThresholdCents: 0 },
      () => source.readTreasuryBaseUnits(treasuryUsdcAta),
    );
    const processor = makeWithdrawProcessor(db, treasurySigner);
    const confirmer = makeWithdrawConfirmer(db, ledger, makeRpcChainStatusReader(rpcUrl));

    // ---- 4. dest USDC balance BEFORE (exact base units) ----
    const [destAta] = await findAssociatedTokenPda({
      owner: address(destWallet),
      mint: address(usdcMint),
      tokenProgram: address(LEGACY_TOKEN_PROGRAM),
    });
    const destBefore = await source.readTreasuryBaseUnits(destAta).catch(() => {
      fail(`destination USDC ATA ${destAta} not found — DEST_WALLET must already hold a devnet USDC ATA`);
    });
    console.log(`dest USDC before: ${destBefore} base units (ata ${destAta})`);

    // ---- 5. reserve ----
    const reserved = await withdrawals.reserve(user.id, amountCents);
    if (reserved.status !== "ok") fail(`reserve returned '${reserved.status}'`);
    const withdrawalId = reserved.withdrawalId;
    console.log(`reserved → ${withdrawalId} (state ${reserved.state})`);

    // ---- 6. approve → sign → broadcast ----
    const approved = await processor.approveAndSend(withdrawalId);
    if (approved.status !== "sent") fail(`approveAndSend returned '${approved.status}'`);
    console.log(`approved → broadcast (status sent)`);

    // ---- 7. poll the confirmer until terminal ----
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let outcome: "confirmed" | "reversed" | "pending" | "needs_review" | "skip" = "skip";
    while (Date.now() < deadline) {
      outcome = await confirmer.confirm(withdrawalId);
      if (outcome === "confirmed" || outcome === "reversed" || outcome === "needs_review") break;
      await sleep(CONFIRM_POLL_MS);
    }
    console.log(`confirmer outcome: ${outcome}`);
    if (outcome !== "confirmed") {
      fail(`expected 'confirmed' within ${CONFIRM_TIMEOUT_MS / 1000}s, got '${outcome}' (check the tx on a devnet explorer)`);
    }

    // ---- 8. assertions: USDC moved + ledger reconciled ----
    const destAfter = await source.readTreasuryBaseUnits(destAta);
    const moved = destAfter - destBefore;
    const expected = centsToBaseUnits(BigInt(amountCents));
    const cashFinal = await ledger.balance(user.id, "cash");

    console.log(`\n--- results ---`);
    console.log(`  dest USDC after : ${destAfter} (moved ${moved} base units, expected ${expected})`);
    console.log(`  cash: ${cashAfterSeed}c → ${cashFinal}c (expected ${cashAfterSeed - amountCents}c)`);

    if (moved !== expected) fail(`on-chain delta ${moved} != expected ${expected} base units`);
    if (cashFinal !== cashAfterSeed - amountCents) fail(`cash not debited exactly once (got ${cashFinal}c, expected ${cashAfterSeed - amountCents}c)`);

    console.log(`\n✓ PASS — devnet USDC moved treasury→dest and the ledger reconciled. withdrawal ${withdrawalId} confirmed.`);
    await raw.close();
  } catch (e) {
    await raw.close().catch(() => {});
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
