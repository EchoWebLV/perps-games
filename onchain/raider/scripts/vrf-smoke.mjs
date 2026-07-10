// vrf-smoke.mjs — request_roll with the dev wallet, then poll the RollSlot until the
// MagicBlock oracle fulfills. Proves the devnet VRF pipeline end-to-end in isolation.
// Then proves the core security property: a forged fulfillment (dev wallet as the
// "vrf identity") is rejected on-chain by the scoped-identity address constraint.
// Run: node scripts/vrf-smoke.mjs
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const idl = JSON.parse(readFileSync(new URL("../target/idl/crate_roll.json", import.meta.url), "utf8"));
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${homedir()}/.config/solana/lazer-probe.json`, "utf8"))));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const wallet = new anchor.Wallet(kp);
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const [rollSlot] = PublicKey.findProgramAddressSync([Buffer.from("roll"), kp.publicKey.toBuffer()], program.programId);
const before = await program.account.rollSlot.fetchNullable(rollSlot);
const expect = (before ? Number(before.nonce) : 0) + 1;

console.log("requesting roll (expect nonce", expect, ")…");
const sig = await program.methods.requestRoll().accounts({ payer: kp.publicKey }).rpc();
console.log("request tx:", sig);

const t0 = Date.now();
for (;;) {
  const s = await program.account.rollSlot.fetch(rollSlot);
  if (s.fulfilled && Number(s.nonce) === expect) {
    console.log(`FULFILLED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log("randomness:", Buffer.from(s.randomness).toString("hex"));
    break;
  }
  if (Date.now() - t0 > 30_000) { console.error("TIMEOUT: no fulfillment in 30s"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}

// A forged fulfillment MUST fail: callback_fulfill_roll requires the SCOPED VRF program identity
// (scoped_vrf_identity(&crate::ID)) as signer; the dev wallet is not it, so this call must be
// rejected by the address constraint. Any error here is a PASS; acceptance is the failure.
try {
  await program.methods.callbackFulfillRoll(Array.from({ length: 32 }, () => 7))
    .accounts({ vrfProgramIdentity: kp.publicKey, rollSlot })
    .rpc();
  console.error("SECURITY FAIL: forged callback was ACCEPTED");
  process.exit(1);
} catch {
  console.log("forged callback rejected (address constraint holds)");
}
process.exit(0);
