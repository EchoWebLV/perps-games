import { PublicKey } from "@solana/web3.js";

// Devnet on-chain constants for the deployed `raider` program. Endpoint defaults
// mirror onchain/raider/tests/helpers.ts. BASE_WS is pinned to public devnet so any
// WS-confirmation path uses a known-good socket; on-chain sends use HTTP-poll anyway.
export const CHAIN = {
  PROGRAM_ID: new PublicKey("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv"),
  BASE_RPC: "https://api.devnet.solana.com",
  BASE_WS: "wss://api.devnet.solana.com",
  ER_RPC: "https://devnet.magicblock.app",
  ER_WS: "wss://devnet.magicblock.app",
  BTC_FEED: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"),
  // Multi-asset Lazer feeds (Task 0a — locked + verified vs live Binance and
  // fresh-updating on the ER; see scripts/probe-feeds.mjs). Keyed by asset id.
  FEEDS: {
    BTC: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"),
    ETH: new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"),
    SOL: new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
  } as Record<"BTC" | "ETH" | "SOL", PublicKey>,
  // Asset index convention shared with the program registry: 0=BTC, 1=ETH, 2=SOL.
  ASSET_ID: { BTC: 0, ETH: 1, SOL: 2 } as Record<"BTC" | "ETH" | "SOL", number>,
  VALIDATOR: new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
  DELEGATION_PROGRAM: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"),
  // MagicBlock native task-scheduler program — schedule_tick CPIs the crank to this.
  MAGIC_PROGRAM: new PublicKey("Magic11111111111111111111111111111111111111"),
  // The stable devnet test-USDC mint the demo plays against. Filled by Task 5's
  // bootstrap script output; "" means "not bootstrapped yet" (the demo will warn).
  TEST_USDC_MINT: "48oPKLwGRGkmVFe2hudXQRyZnPUZbYfGgQ2Bnar4mmre",
  USDC_DECIMALS: 6,
} as const;

/** The singleton on-chain feed registry PDA (`[b"feeds"]`) — read by `open` to bind a round to its asset feed. */
export function deriveFeedRegistry(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("feeds")], programId)[0];
}
