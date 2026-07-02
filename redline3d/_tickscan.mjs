// Debug: scan crank ticks in a time window, print raider CU per tick — the settle
// tick consumes far more CU than a Hold heartbeat, exposing WHEN each round settled.
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const ROUND = new PublicKey("4trD8PnmiDZANVhAiGyrQr1Zbvabu8qXYuFLb1WHuNco");
const PROG = "FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv";
const conn = new Connection("https://devnet.magicblock.app", "confirmed");

const FROM = Number(process.argv[2]); // epoch secs
const TO = Number(process.argv[3]);

let before = undefined;
const rows = [];
outer: while (true) {
  const sigs = await conn.getSignaturesForAddress(ROUND, { limit: 1000, before });
  if (!sigs.length) break;
  for (const s of sigs) {
    const t = s.blockTime ?? 0;
    if (t < FROM) break outer;
    if (t <= TO) rows.push(s);
  }
  before = sigs[sigs.length - 1].signature;
}

for (const s of rows.reverse()) {
  const t = new Date((s.blockTime ?? 0) * 1000).toISOString().slice(11, 19);
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const logs = tx.meta?.logMessages ?? [];
  const cuLine = logs.find((l) => l.includes(`Program ${PROG} consumed`));
  const cu = cuLine ? cuLine.match(/consumed (\d+)/)?.[1] : "-";
  const isCrank = logs.some((l) => l.includes("Crank111"));
  const err = tx.meta?.err ? " ERR" : "";
  console.log(`${t} ${isCrank ? "crank" : "user "} cu=${cu}${err}`);
}
