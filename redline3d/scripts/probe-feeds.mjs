// Operator: identify the MagicBlock-ER-relayed Pyth Lazer feed accounts for
// BTC/ETH/SOL and their on-chain feed_ids. Disambiguates by matching each ER feed
// against the live Binance price AND confirming it is freshly updating (a stale or
// secondary relay won't track) — price-range guessing alone is WRONG (multiple
// unrelated feeds share a price band; e.g. a ~$200 feed is NOT SOL).
//
// Run: node redline3d/scripts/probe-feeds.mjs
//
// LOCKED 2026-06-29 (BTC calibrates to the deployed const; ETH/SOL verified vs
// Binance within 0.15% AND confirmed fresh-updating over a 4s window):
//   asset feed_account                                  feed_id (hex)
//   BTC   71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr  59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65
//   ETH   5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG  492876f163efc513083c19ff18162b4539280e6df23b732ee7055fa5530f7db1
//   SOL   ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu  c6ad3e841d9c0f248adff90cf776f839fd59f1cbd8ffbc8f9402883ea16e8420

import { Connection, PublicKey } from "@solana/web3.js";

const PYTH = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const er = new Connection("https://devnet.magicblock.app", "confirmed");

// Decode the PriceUpdateV2 the same way price.rs does.
function decode(buf) {
  let o = 8; o += 32; const tag = buf[o]; o += 1; if (tag === 0) o += 1;
  const feed_id = Buffer.from(buf.subarray(o, o + 32)); o += 32;
  const price = buf.readBigInt64LE(o); o += 8; o += 8;
  const expo = buf.readInt32LE(o); o += 4;
  const pub = buf.readBigInt64LE(o);
  return { feed_id: feed_id.toString("hex"), usd: Number(price) * Math.pow(10, -Math.abs(expo)), pub: Number(pub) };
}
const binance = async (sym) => Number((await (await fetch("https://api.binance.com/api/v3/ticker/price?symbol=" + sym)).json()).price);
const snap = async () => (await er.getProgramAccounts(PYTH, { filters: [{ dataSize: 134 }] })).map((x) => ({ pk: x.pubkey.toBase58(), ...decode(x.account.data) }));

const [bBtc, bEth, bSol] = await Promise.all([binance("BTCUSDT"), binance("ETHUSDT"), binance("SOLUSDT")]);
console.log("Binance: BTC", bBtc, "ETH", bEth, "SOL", bSol);
const s1 = await snap();
await new Promise((r) => setTimeout(r, 4000));
const m2 = Object.fromEntries((await snap()).map((r) => [r.pk, r]));

function best(ref, label) {
  const cands = s1
    .filter((r) => Math.abs(r.usd - ref) / ref < 0.06)
    .map((r) => ({ ...r, err: Math.abs(r.usd - ref) / ref, fresh: m2[r.pk] ? m2[r.pk].pub - r.pub : 0 }))
    .sort((a, b) => a.err - b.err);
  console.log(`\n${label} (Binance ${ref}) — canonical = lowest err AND fresh>0:`);
  for (const c of cands) console.log("  ", c.pk, "$" + c.usd.toFixed(2), "err " + (c.err * 100).toFixed(2) + "%", "fresh " + c.fresh + "s", c.feed_id);
}
best(bBtc, "BTC");
best(bEth, "ETH");
best(bSol, "SOL");
