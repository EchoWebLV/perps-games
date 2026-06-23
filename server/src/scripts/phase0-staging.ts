/**
 * Phase 0 — EMPIRICAL staging harness (real-money rails).
 *
 * Runs the GATING staging test #1 (treasury fee-payer sponsorship) against a LIVE Privy
 * staging app. This is the one test that blocks Plan 2 (deposit) and Plan 3 (withdraw):
 * the spec's deposit design has the treasury (a Privy server wallet) sign a tx as fee-payer
 * while a DIFFERENT user wallet is the SPL transfer authority. Phase 0's static pass could
 * not prove Privy will actually sign a "fee-payer-only" slot (sponsor:true is opaque USD
 * gas-credit billing, not on-chain fee-payer) — only a live signing call can.
 *
 * The core question needs NO on-chain funding: signing is offline. We build the tx, call
 * signTransaction(treasuryWalletId), and inspect which signature slots Privy filled.
 *   PASS = treasury's fee-payer slot is signed, the user-authority slot is left empty, and
 *          the call did NOT reject because the treasury isn't the instruction authority.
 *   FAIL = Privy rejects, or refuses to sign a fee-payer-only slot. Then the §5 deposit
 *          sponsorship is broken → fall back to user-pays-gas / pre-fund / Privy-chosen sponsor.
 *
 * Usage (from server/, with PRIVY_APP_ID + PRIVY_APP_SECRET in .env):
 *   npx tsx src/scripts/phase0-staging.ts
 * Reuse provisioned wallets across runs by setting PHASE0_TREASURY_WALLET_ID +
 * PHASE0_USER_WALLET_ID in .env (the script prints them to save on first run).
 *
 * SAFETY: devnet / staging only. No real money. Credentials live in server/.env (gitignored)
 * and are NEVER pasted into chat. This script only SIGNS (offline) — it does not broadcast.
 */
import { config as loadEnv } from "dotenv";
import { PrivyClient } from "@privy-io/node";
import { address, type Address } from "@solana/kit";
import { buildUnsignedTransferCheckedWireTx } from "../solana/transfer-tx.js";

loadEnv();

/** A throwaway 6-decimal mint stand-in; signing does not validate it exists on-chain. */
const TEST_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // mainnet USDC pubkey, used only as bytes
/** Signing ignores the blockhash; a fixed dummy keeps test #1 funding-free. */
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`\n[phase0] missing required env ${name}. Put it in server/.env (gitignored).`);
    process.exit(2);
  }
  return v;
}

/**
 * Reuse a wallet from env (both id + address, since the public-api service exposes no get-by-id),
 * else create a Solana server wallet and print both for the user to persist.
 */
async function getOrCreateWallet(
  client: PrivyClient,
  idKey: string,
  addrKey: string,
  label: string,
): Promise<{ id: string; address: Address }> {
  const existingId = process.env[idKey];
  const existingAddr = process.env[addrKey];
  if (existingId?.trim() && existingAddr?.trim()) {
    console.log(`[phase0] reusing ${label} wallet ${existingId} (${existingAddr})`);
    return { id: existingId, address: address(existingAddr) };
  }
  const w = await client.wallets().create({ chain_type: "solana" });
  console.log(
    `[phase0] created ${label} wallet — save to .env:\n    ${idKey}=${w.id}\n    ${addrKey}=${w.address}`,
  );
  return { id: w.id, address: address(w.address) };
}

/** Parse the shortvec signature count + slots from a base64 wire tx (no decoder needed). */
function readSignatureSlots(signedTxBase64: string): { count: number; slots: Buffer[] } {
  const buf = Buffer.from(signedTxBase64, "base64");
  const count = buf[0]; // shortvec; fine for the 1–2 signers here
  const slots: Buffer[] = [];
  for (let i = 0; i < count; i++) slots.push(buf.subarray(1 + i * 64, 1 + (i + 1) * 64));
  return { count, slots };
}

const isAllZero = (b: Buffer): boolean => b.every((x) => x === 0);

async function main(): Promise<void> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const client = new PrivyClient({ appId, appSecret });

  console.log("\n=== Phase 0 staging test #1 — treasury fee-payer sponsorship (signing slot) ===");
  const treasury = await getOrCreateWallet(client, "PHASE0_TREASURY_WALLET_ID", "PHASE0_TREASURY_ADDRESS", "treasury");
  const user = await getOrCreateWallet(client, "PHASE0_USER_WALLET_ID", "PHASE0_USER_ADDRESS", "user");

  if (treasury.id === user.id) {
    console.error("[phase0] treasury and user must be DIFFERENT wallets; aborting.");
    process.exit(2);
  }

  // Build a transferChecked tx: treasury = fee-payer, user = transfer authority (a DIFFERENT wallet).
  // source/dest are placeholders — irrelevant to the signing-slot question this test answers.
  const wireTx = buildUnsignedTransferCheckedWireTx({
    source: user.address,
    mint: TEST_MINT,
    destination: treasury.address,
    authority: user.address, // reserved as a signer slot Privy must NOT need to fill
    feePayer: treasury.address, // the slot Privy SHOULD fill
    amount: 1_000_000n,
    decimals: 6,
    lifetime: { blockhash: DUMMY_BLOCKHASH as never, lastValidBlockHeight: 1_000n },
  });

  console.log(`[phase0] asking Privy to sign treasury's fee-payer slot only (wallet ${treasury.id})…`);
  let signed: string;
  try {
    const res = await client.wallets().solana().signTransaction(treasury.id, { transaction: wireTx });
    signed = res.signed_transaction;
  } catch (err) {
    console.error(
      "\n❌ FAIL — Privy REJECTED signing a fee-payer-only tx for the treasury:\n",
      err instanceof Error ? err.message : err,
    );
    console.error(
      "→ §5 deposit fee-payer sponsorship is BROKEN as designed. Fall back to user-pays-gas / " +
        "pre-fund tiny SOL / Privy-chosen sponsor. Record this in the findings-doc staging checklist.",
    );
    process.exit(1);
  }

  const { count, slots } = readSignatureSlots(signed);
  const treasurySigned = count >= 1 && !isAllZero(slots[0]);
  const userUnsigned = count >= 2 && isAllZero(slots[1]);

  console.log(`[phase0] signed tx has ${count} signature slot(s); treasury-signed=${treasurySigned} user-unsigned=${userUnsigned}`);

  if (count === 2 && treasurySigned && userUnsigned) {
    console.log(
      "\n✅ PASS — Privy signed ONLY the treasury's fee-payer slot, leaving the user-authority slot " +
        "empty. The §5 deposit fee-payer-sponsorship design holds (the user/Privy still fills the " +
        "authority slot before broadcast). Plan 2 (deposit) may proceed on this design.",
    );
    console.log(
      "Next: items 2–6 (idempotency, byte fidelity, hash semantics, CAIP-2), then 7–10 (quorum, " +
        "intents authorize route, policy). See the staging checklist in the Phase 0 findings doc.",
    );
    process.exit(0);
  }

  console.error(
    "\n⚠️  INCONCLUSIVE — unexpected signature layout (expected 2 slots: treasury signed, user empty). " +
      "Inspect the decoded tx manually before trusting the fee-payer design.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[phase0] unexpected error:", err);
  process.exit(1);
});
