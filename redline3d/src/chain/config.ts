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
  VALIDATOR: new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
  DELEGATION_PROGRAM: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"),
  // MagicBlock native task-scheduler program — schedule_tick CPIs the crank to this.
  MAGIC_PROGRAM: new PublicKey("Magic11111111111111111111111111111111111111"),
  // The stable devnet test-USDC mint the demo plays against. Filled by Task 5's
  // bootstrap script output; "" means "not bootstrapped yet" (the demo will warn).
  TEST_USDC_MINT: "8tZXkKuat9KoisUjFkq4kBUa1p746Mn4tj4i3st5Th1Y",
  USDC_DECIMALS: 6,
} as const;
