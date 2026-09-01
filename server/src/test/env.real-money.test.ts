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

  it("defaults CASH_SETTLER_ENABLED off (cash rounds fail closed) and parses true", () => {
    expect(parseEnv({ ...base } as any).CASH_SETTLER_ENABLED).toBe(false);
    expect(parseEnv({ ...base, CASH_SETTLER_ENABLED: "true" } as any).CASH_SETTLER_ENABLED).toBe(true);
  });

  it("THROWS when real money is on but Solana config is missing (fail closed)", () => {
    expect(() => parseEnv({ ...base, REAL_MONEY_ENABLED: "true", CHAIN_FAMILY: "solana" } as any)).toThrow(/SOLANA_RPC_URL|USDC_MINT|TREASURY_USDC_ATA/);
  });

  it("parses a fully-configured real-money env", () => {
    const e = parseEnv({
      ...base, REAL_MONEY_ENABLED: "true", CHAIN_FAMILY: "solana",
      SOLANA_RPC_URL: "https://rpc.example/devnet",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      TREASURY_USDC_ATA: "9wFF1111111111111111111111111111111111111111",
      TREASURY_OWNER_PUBKEY: "53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r",
    } as any);
    expect(e.REAL_MONEY_ENABLED).toBe(true);
    expect(e.SOLANA_CLUSTER).toBe("mainnet-beta");
    expect(e.TREASURY_OWNER_PUBKEY).toBe("53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r");
  });
});

describe("CHAIN_FAMILY", () => {
  it("defaults to evm", () => {
    expect(parseEnv({ ...base } as any).CHAIN_FAMILY).toBe("evm");
  });

  it("evm family requires EVM vars when real money is on", () => {
    expect(() => parseEnv({ ...base, REAL_MONEY_ENABLED: "true" } as any)).toThrow(/EVM_RPC_URL/);
    expect(() =>
      parseEnv({
        ...base,
        REAL_MONEY_ENABLED: "true",
        EVM_RPC_URL: "https://rpc.testnet.chain.robinhood.com",
        EVM_CHAIN_ID: "46630",
        EVM_USDC_ADDRESS: "0x" + "a".repeat(40),
        EVM_TREASURY_ADDRESS: "0x" + "b".repeat(40),
      } as any),
    ).not.toThrow();
  });

  it("solana family keeps the old requirements", () => {
    expect(() => parseEnv({ ...base, REAL_MONEY_ENABLED: "true", CHAIN_FAMILY: "solana" } as any)).toThrow(
      /SOLANA_RPC_URL/,
    );
  });

  it("EVM_TREASURY_SECRET requires EVM_TREASURY_ADDRESS", () => {
    expect(() =>
      parseEnv({ ...base, CHAIN_FAMILY: "evm", EVM_TREASURY_SECRET: "0x" + "1".repeat(64) } as any),
    ).toThrow(/EVM_TREASURY_ADDRESS/);
  });
});
