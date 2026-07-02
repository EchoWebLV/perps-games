// Debug reader: decode the dev wallet's Round PDA on L1 + ER and recompute the exit
// equity the way settle.rs does, to compare against the stamped sl_fp/tp_fp.
import fs from "node:fs";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { BorshAccountsCoder } = anchorPkg;

const idl = JSON.parse(fs.readFileSync(new URL("./src/chain/idl/raider.json", import.meta.url)));
const env = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
const secB64 = /VITE_DEV_SECRET=([^\n]+)/.exec(env)[1].trim();
const kp = Keypair.fromSecretKey(Buffer.from(secB64, "base64"));
const owner = kp.publicKey;
const programId = new PublicKey(idl.address);
const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], programId);
const coder = new BorshAccountsCoder(idl);
const DELEG = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const SCALE = 1_000_000n;

console.log("owner:", owner.toBase58());
console.log("round PDA:", round.toBase58());

function analyze(r) {
  const dir = BigInt(r.dir);
  const lev = BigInt(r.lev);
  const entry = BigInt(r.entry_raw.toString());
  const exit = BigInt(r.exit_raw.toString());
  const banked = BigInt(r.banked.toString());
  const stake = BigInt(r.stake.toString());
  const out = {
    status: r.status, outcome: r.outcome,
    dir: r.dir, lev: r.lev,
    stake: stake.toString(),
    entryRaw: entry.toString(), exitRaw: exit.toString(),
    banked: banked.toString(),
    liqFp: r.liq_fp, graceSecs: r.grace_secs, slFp: r.sl_fp, tpFp: r.tp_fp, refundFp: r.refund_fp,
    entryTs: Number(r.entry_ts), exitTs: Number(r.exit_ts), deadlineTs: Number(r.deadline_ts),
    ranSecs: Number(r.exit_ts) - Number(r.entry_ts),
    payout: r.payout.toString(),
  };
  if (entry > 0n && exit > 0n) {
    const ratio = (exit * SCALE) / entry;
    const seg = dir * lev * (ratio - SCALE);
    let eq = SCALE + banked + seg;
    if (eq < 0n) eq = 0n;
    out.exitEqFp = eq.toString();
    out.exitEqX = Number(eq) / 1e6;
    out.priceMovePct = (Number(exit - entry) / Number(entry)) * 100;
    // leg-only equity (banked ignored) — what the position alone would show
    let eqNoBank = SCALE + seg;
    if (eqNoBank < 0n) eqNoBank = 0n;
    out.exitEqNoBankX = Number(eqNoBank) / 1e6;
    out.impliedPayout = ((stake * (eq < 25_000_000n ? eq : 25_000_000n) * 950_000n) / SCALE / SCALE).toString();
  }
  return out;
}

async function show(name, url) {
  try {
    const conn = new Connection(url, "confirmed");
    const ai = await conn.getAccountInfo(round);
    if (!ai) { console.log(`\n=== ${name}: no account`); return; }
    const deleg = ai.owner.toBase58() === DELEG;
    console.log(`\n=== ${name} | account owner: ${ai.owner.toBase58()}${deleg ? "  <-- DELEGATED (live session)" : ""}`);
    const r = coder.decode("Round", ai.data);
    console.log(JSON.stringify(analyze(r), null, 1));
  } catch (e) {
    console.log(`\n=== ${name}: ERROR ${e.message}`);
  }
}

await show("L1 devnet", "https://api.devnet.solana.com");
await show("ER magicblock", "https://devnet.magicblock.app");
