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
console.log(`\n>>> paste into src/chain/config.ts: TEST_USDC_MINT: "${mint.toBase58()}"`);
