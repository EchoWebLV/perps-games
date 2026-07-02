// Debug: paginate ER tx history on the round PDA, print ONLY raider instructions
// (open/close/flip/lever/schedule_tick) + failed txs — skip bare crank ticks.
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { BorshInstructionCoder } = anchorPkg;

const idl = JSON.parse(fs.readFileSync(new URL("./src/chain/idl/raider.json", import.meta.url)));
const ixCoder = new BorshInstructionCoder(idl);
const ROUND = new PublicKey("4trD8PnmiDZANVhAiGyrQr1Zbvabu8qXYuFLb1WHuNco");
const PROG = idl.address;
const conn = new Connection("https://devnet.magicblock.app", "confirmed");

const CUTOFF_MIN = Number(process.argv[2] ?? 60); // how far back to walk
const now = Math.floor(Date.now() / 1000);
const fmt = (v) => (typeof v === "object" && v !== null && v.toString ? v.toString() : v);

let before = undefined;
let walked = 0;
const rows = [];
outer: while (walked < 5000) {
  const sigs = await conn.getSignaturesForAddress(ROUND, { limit: 1000, before });
  if (sigs.length === 0) break;
  for (const s of sigs) {
    walked++;
    if ((s.blockTime ?? 0) < now - CUTOFF_MIN * 60) break outer;
    rows.push(s);
  }
  before = sigs[sigs.length - 1].signature;
}
console.log(`walked ${walked} sigs, window last ${CUTOFF_MIN}min\n`);

for (const s of rows.reverse()) {
  const t = new Date((s.blockTime ?? 0) * 1000).toISOString().slice(11, 19);
  try {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    const ixs = msg.compiledInstructions ?? msg.instructions;
    const parts = [];
    let hasRaider = false;
    for (const ix of ixs) {
      const pid = keys[ix.programIdIndex].toBase58();
      if (pid !== PROG) continue;
      hasRaider = true;
      let decoded = null;
      try { decoded = ixCoder.decode(Buffer.from(ix.data)); } catch {}
      if (decoded) {
        const args = Object.fromEntries(Object.entries(decoded.data ?? {}).map(([k, v]) => [k, fmt(v)]));
        parts.push(`${decoded.name}(${JSON.stringify(args)})`);
      } else parts.push("raider:?");
    }
    if (!hasRaider && !tx.meta?.err) continue; // bare crank/Magic tick, fine
    if (!hasRaider && tx.meta?.err) {
      // failed crank tick? show its logs briefly
      const logs = (tx.meta?.logMessages ?? []).slice(-3);
      console.log(`${t} CRANK-ERR ${JSON.stringify(tx.meta.err)} :: ${logs.join(" / ")}`);
      continue;
    }
    console.log(`${t} ${parts.join(" | ")}${tx.meta?.err ? "  ERR=" + JSON.stringify(tx.meta.err) : ""}`);
  } catch (e) {
    console.log(`${t} read error: ${e.message}`);
  }
}
