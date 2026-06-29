// Operator one-time devnet bootstrap: create a stable test-USDC mint (or reuse one
// passed as argv[2]), init_house + fund_house for it, and print the mint pubkey to
// paste into src/chain/config.ts (TEST_USDC_MINT). Run:
//   ANCHOR_WALLET=~/.config/solana/lazer-probe.json node scripts/bootstrap-devnet.mjs
import anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import idl from "../src/chain/idl/raider.json" with { type: "json" };

const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const HOUSE_FUND = Number(process.env.HOUSE_FUND || 50_000_000); // 50 USDC bankroll
const conn = new Connection(RPC, { commitment: "confirmed" });
const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
const funder = anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const mint = process.argv[2]
  ? new PublicKey(process.argv[2])
  : await createMint(conn, funder, funder.publicKey, null, 6);
console.log("MINT", mint.toBase58());

const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

const existing = await program.account.houseBalance.fetchNullable(house);
if (!existing) {
  await program.methods.initHouse().accounts({
    authority: funder.publicKey, mint, house, vaultAuthority, vaultToken,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });
  console.log("init_house done");
}
const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, HOUSE_FUND);
await program.methods.fundHouse(new anchor.BN(HOUSE_FUND)).accounts({
  funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
}).rpc({ skipPreflight: true });
const h = await program.account.houseBalance.fetch(house);
console.log(`house funded: balance=${h.balance.toString()} locked=${h.locked.toString()}`);

// --- Feed registry (singleton [b"feeds"], multi-asset) -----------------------
// The 3 feeds are the LOCKED Task-0a identities (redline3d/scripts/probe-feeds.mjs):
// account + feed_id verified against live Binance AND fresh-updating on the ER.
// asset id convention: 0=BTC, 1=ETH, 2=SOL.
const FEEDS = [
  { asset: 0, name: "BTC", feed: "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr", feed_id: "59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65" },
  { asset: 1, name: "ETH", feed: "5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG", feed_id: "492876f163efc513083c19ff18162b4539280e6df23b732ee7055fa5530f7db1" },
  { asset: 2, name: "SOL", feed: "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu", feed_id: "c6ad3e841d9c0f248adff90cf776f839fd59f1cbd8ffbc8f9402883ea16e8420" },
];
const [registry] = PublicKey.findProgramAddressSync([Buffer.from("feeds")], program.programId);
const regExisting = await program.account.feedRegistry.fetchNullable(registry);
if (!regExisting) {
  await program.methods.initFeedRegistry().accounts({
    authority: funder.publicKey, registry, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });
  console.log(`init_feed_registry done (authority=${funder.publicKey.toBase58()})`);
} else if (!regExisting.authority.equals(funder.publicKey)) {
  throw new Error(`registry authority is ${regExisting.authority.toBase58()}, not the bootstrap wallet — cannot set_feed`);
}
for (const f of FEEDS) {
  await program.methods
    .setFeed(f.asset, new PublicKey(f.feed), Array.from(Buffer.from(f.feed_id, "hex")), true)
    .accounts({ authority: funder.publicKey, registry })
    .rpc({ skipPreflight: true });
  console.log(`set_feed ${f.name} (asset ${f.asset}) -> ${f.feed}`);
}
const reg = await program.account.feedRegistry.fetch(registry);
for (const f of FEEDS) {
  const e = reg.feeds[f.asset];
  const ok = e.enabled && e.feed.toBase58() === f.feed && Buffer.from(e.feedId).toString("hex") === f.feed_id;
  console.log(`  verify ${f.name}: ${ok ? "OK" : "MISMATCH"} enabled=${e.enabled} feed=${e.feed.toBase58()}`);
  if (!ok) throw new Error(`registry entry for ${f.name} did not match after set_feed`);
}
console.log(`registry ${registry.toBase58()} bootstrapped with ${FEEDS.length} feeds`);

console.log(`\n>>> paste into src/chain/config.ts: TEST_USDC_MINT: "${mint.toBase58()}"`);
