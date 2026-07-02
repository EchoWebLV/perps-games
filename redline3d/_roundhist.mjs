// Debug: reconstruct the session timeline from ER tx history on the round PDA.
// Decodes each instruction (open args incl. sl/tp!) + shows tick settles.
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { BorshInstructionCoder } = anchorPkg;

const idl = JSON.parse(fs.readFileSync(new URL("./src/chain/idl/raider.json", import.meta.url)));
const ixCoder = new BorshInstructionCoder(idl);
const ROUND = new PublicKey("4trD8PnmiDZANVhAiGyrQr1Zbvabu8qXYuFLb1WHuNco");
const PROG = idl.address;
const conn = new Connection("https://devnet.magicblock.app", "confirmed");

const sigs = await conn.getSignaturesForAddress(ROUND, { limit: 100 });
console.log(`signatures: ${sigs.length} (newest first)\n`);

const fmt = (v) => (typeof v === "object" && v !== null && v.toString ? v.toString() : v);

for (const s of sigs.reverse()) {
  let line = `${new Date((s.blockTime ?? 0) * 1000).toISOString().slice(11, 19)} `;
  try {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) { console.log(line + "(tx not found)"); continue; }
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    const ixs = msg.compiledInstructions ?? msg.instructions;
    const parts = [];
    for (const ix of ixs) {
      const pid = keys[ix.programIdIndex].toBase58();
      if (pid !== PROG) { parts.push(`[${pid.slice(0, 6)}…]`); continue; }
      const dataBuf = Buffer.from(ix.data, typeof ix.data === "string" ? "base64" : undefined);
      let decoded = null;
      try { decoded = ixCoder.decode(dataBuf, "base58" in ix ? "base58" : undefined); } catch {}
      if (!decoded) { try { decoded = ixCoder.decode(dataBuf); } catch {} }
      if (decoded) {
        const args = Object.fromEntries(Object.entries(decoded.data ?? {}).map(([k, v]) => [k, fmt(v)]));
        parts.push(`${decoded.name}(${JSON.stringify(args)})`);
      } else {
        parts.push(`raider:?(${dataBuf.length}b)`);
      }
    }
    // grep the program logs for settle info
    const logs = (tx.meta?.logMessages ?? []).filter((l) => /outcome|settle|liq|payout|equity|Error/i.test(l));
    console.log(line + parts.join(" | ") + (tx.meta?.err ? `  ERR=${JSON.stringify(tx.meta.err)}` : ""));
    for (const l of logs) console.log("      " + l);
  } catch (e) {
    console.log(line + `read error: ${e.message}`);
  }
}
