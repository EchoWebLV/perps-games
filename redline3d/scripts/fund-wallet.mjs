// Operator: airdrop SOL + mint test USDC to a player address. Run:
//   node scripts/fund-wallet.mjs <PLAYER_ADDRESS> <MINT_ADDRESS>
import anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readFileSync } from "node:fs";

const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const USDC = Number(process.env.USDC || 10_000_000); // 10 USDC
const conn = new Connection(RPC, { commitment: "confirmed" });
const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
const funder = anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
const player = new PublicKey(process.argv[2]);
const mint = new PublicKey(process.argv[3]);

const before = await conn.getBalance(player);
if (before < 0.05 * LAMPORTS_PER_SOL) {
  const sig = await conn.requestAirdrop(player, 0.1 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("airdropped 0.1 SOL");
}
const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player);
await mintTo(conn, funder, mint, ata.address, funder.publicKey, USDC);
console.log(`minted ${USDC} test-USDC to ${player.toBase58()} (ata ${ata.address.toBase58()})`);
