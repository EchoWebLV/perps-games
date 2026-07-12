import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";

describe("parseEnv auth flags", () => {
  it("DEV_AUTH defaults on, and off only when explicitly 'false'", () => {
    expect(parseEnv({}).DEV_AUTH).toBe(true);
    expect(parseEnv({ DEV_AUTH: "false" }).DEV_AUTH).toBe(false);
  });
  it("defaults CORS to the current dev frontend origins", () => {
    expect(parseEnv({}).CORS_ORIGINS.split(",")).toEqual(expect.arrayContaining([
      "http://localhost:4000",
      "http://127.0.0.1:4000",
      "https://localhost",
      "capacitor://localhost",
    ]));
  });
  it("requires SESSION_SECRET in production", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrowError(/SESSION_SECRET is required in production/);
  });
  it("accepts a 32 character SESSION_SECRET in production", () => {
    const e = parseEnv({ NODE_ENV: "production", SESSION_SECRET: "s".repeat(32) });
    expect(e.SESSION_SECRET).toBe("s".repeat(32));
  });
  it("requires FEE_PAYER_SECRET and FEE_PAYER_OWNER_PUBKEY together when real money is enabled", () => {
    expect(() => parseEnv({
      REAL_MONEY_ENABLED: "true",
      SOLANA_RPC_URL: "https://rpc.example/devnet",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      TREASURY_USDC_ATA: "9wFF1111111111111111111111111111111111111111",
      FEE_PAYER_SECRET: "c2VjcmV0",
    })).toThrowError(/FEE_PAYER_SECRET and FEE_PAYER_OWNER_PUBKEY must be set together/);
    expect(() => parseEnv({
      REAL_MONEY_ENABLED: "true",
      SOLANA_RPC_URL: "https://rpc.example/devnet",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      TREASURY_USDC_ATA: "9wFF1111111111111111111111111111111111111111",
      FEE_PAYER_OWNER_PUBKEY: "53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r",
    })).toThrowError(/FEE_PAYER_SECRET and FEE_PAYER_OWNER_PUBKEY must be set together/);
  });
  it("accepts FEE_PAYER_SECRET and FEE_PAYER_OWNER_PUBKEY together when real money is enabled", () => {
    const e = parseEnv({
      REAL_MONEY_ENABLED: "true",
      SOLANA_RPC_URL: "https://rpc.example/devnet",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      TREASURY_USDC_ATA: "9wFF1111111111111111111111111111111111111111",
      FEE_PAYER_SECRET: "c2VjcmV0",
      FEE_PAYER_OWNER_PUBKEY: "53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r",
      TREASURY_OWNER_PUBKEY: "8k3DWhLVU9esPZgCZKpN17XAdBCASGXykheGMGdXpcdu",
    });
    expect(e.FEE_PAYER_SECRET).toBe("c2VjcmV0");
    expect(e.FEE_PAYER_OWNER_PUBKEY).toBe("53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r");
  });
  it("requires TREASURY_OWNER_PUBKEY when fee sponsorship is configured", () => {
    expect(() => parseEnv({
      REAL_MONEY_ENABLED: "true",
      SOLANA_RPC_URL: "https://rpc.example/devnet",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      TREASURY_USDC_ATA: "9wFF1111111111111111111111111111111111111111",
      FEE_PAYER_SECRET: "c2VjcmV0",
      FEE_PAYER_OWNER_PUBKEY: "53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r",
    })).toThrowError(/TREASURY_OWNER_PUBKEY is required when fee sponsorship is configured/);
  });
});
