// Derive the treasury's USDC associated token account (ATA) for the configured owner + mainnet USDC.
// The server watches this ATA for inbound deposits; the user sends USDC to the OWNER and the wallet
// creates/funds this ATA automatically on the first transfer.
import "dotenv/config";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main(): Promise<void> {
  const owner = process.env.TREASURY_OWNER_PUBKEY;
  if (!owner) {
    console.error("TREASURY_OWNER_PUBKEY not set in server/.env");
    process.exit(1);
  }
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(MAINNET_USDC),
    tokenProgram: address(LEGACY_TOKEN_PROGRAM),
  });
  console.log("USDC_MINT=" + MAINNET_USDC);
  console.log("TREASURY_USDC_ATA=" + ata);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
