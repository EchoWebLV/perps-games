import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";

const base = { DATABASE_URL: "postgres://x" };
const evmMoney = {
  REAL_MONEY_ENABLED: "true",
  EVM_RPC_URL: "https://rpc.testnet.chain.robinhood.com",
  EVM_CHAIN_ID: "46630",
  EVM_USDC_ADDRESS: "0x" + "a".repeat(40),
  EVM_TREASURY_ADDRESS: "0x" + "b".repeat(40),
};

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
    const e = parseEnv({ ...base, ...evmMoney } as any);
    expect(e.EVM_CHAIN_ID).toBe(46630);
  });

  it("solana family keeps the old requirements", () => {
    expect(() => parseEnv({ ...base, REAL_MONEY_ENABLED: "true", CHAIN_FAMILY: "solana" } as any)).toThrow(
      /SOLANA_RPC_URL/,
    );
  });

  it("EVM_TREASURY_SECRET requires EVM_TREASURY_ADDRESS even when real money is off", () => {
    expect(() =>
      parseEnv({ ...base, CHAIN_FAMILY: "evm", EVM_TREASURY_SECRET: "0x" + "1".repeat(64) } as any),
    ).toThrow(/EVM_TREASURY_ADDRESS/);
  });

  it("rejects an EVM address that is not a 0x-prefixed 20-byte hex string", () => {
    expect(() => parseEnv({ ...base, EVM_TREASURY_ADDRESS: "b".repeat(40) } as any)).toThrow(
      /EVM_TREASURY_ADDRESS/,
    );
  });

  it("lowercases EVM addresses at the seam", () => {
    const e = parseEnv({
      ...base,
      EVM_USDC_ADDRESS: "0xA0b86991c6218B36c1d19D4a2e9Eb0cE3606eB48",
      EVM_TREASURY_ADDRESS: "0xDD8D" + "e".repeat(36),
    } as any);
    expect(e.EVM_USDC_ADDRESS).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(e.EVM_TREASURY_ADDRESS).toBe("0xdd8d" + "e".repeat(36));
  });

  it("falls back to 12 confirmations when EVM_CONFIRMATIONS is blank (never 0)", () => {
    expect(parseEnv({ ...base, EVM_CONFIRMATIONS: "" } as any).EVM_CONFIRMATIONS).toBe(12);
    expect(parseEnv({ ...base, EVM_CONFIRMATIONS: "3" } as any).EVM_CONFIRMATIONS).toBe(3);
  });

  it("ignores a leftover Solana TREASURY_SECRET on an evm boot", () => {
    expect(() => parseEnv({ ...base, ...evmMoney, TREASURY_SECRET: "[1,2,3]" } as any)).not.toThrow();
  });

  it("still pairs TREASURY_SECRET with TREASURY_OWNER_PUBKEY on a money-off solana boot", () => {
    expect(() => parseEnv({ ...base, CHAIN_FAMILY: "solana", TREASURY_SECRET: "[1,2,3]" } as any)).toThrow(
      /TREASURY_OWNER_PUBKEY is required when TREASURY_SECRET is set/,
    );
  });
});
