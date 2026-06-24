import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";

const base = { DATABASE_URL: "postgres://x" };

describe("real-money env gating", () => {
  it("defaults REAL_MONEY_ENABLED off and leaves Solana config optional", () => {
    const e = parseEnv({ ...base } as any);
    expect(e.REAL_MONEY_ENABLED).toBe(false);
    expect(e.DEPOSIT_MIN_CENTS).toBe(100);
    expect(e.DEPOSIT_MAX_CENTS).toBe(500);
  });

  it("THROWS when real money is on but Solana config is missing (fail closed)", () => {
    expect(() => parseEnv({ ...base, REAL_MONEY_ENABLED: "true" } as any)).toThrow(/SOLANA_RPC_URL|USDC_MINT|TREASURY_USDC_ATA/);
  });

  it("parses a fully-configured real-money env", () => {
    const e = parseEnv({
      ...base, REAL_MONEY_ENABLED: "true",
      SOLANA_RPC_URL: "https://rpc.example/devnet",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      TREASURY_USDC_ATA: "9wFF1111111111111111111111111111111111111111",
      TREASURY_WALLET_ID: "wallet_123",
      TREASURY_OWNER_PUBKEY: "53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r",
    } as any);
    expect(e.REAL_MONEY_ENABLED).toBe(true);
    expect(e.SOLANA_CLUSTER).toBe("mainnet-beta");
    expect(e.TREASURY_WALLET_ID).toBe("wallet_123");
    expect(e.TREASURY_OWNER_PUBKEY).toBe("53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r");
  });
});
