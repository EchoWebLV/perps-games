import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("env withdraw send-leg vars", () => {
  it("enables the MagicBlock Highway indexer with safe defaults", () => {
    const e = parseEnv({});
    expect(e.HIGHWAY_INDEXER_ENABLED).toBe(true);
    expect(e.HIGHWAY_INDEXER_RPC).toBe("https://devnet.magicblock.app");
    expect(e.HIGHWAY_INDEXER_POLL_MS).toBe(2000);
  });

  it("defaults WITHDRAW_POLL_MS and leaves TREASURY_SECRET undefined", () => {
    const e = parseEnv({});
    expect(e.WITHDRAW_POLL_MS).toBe(4000);
    expect(e.TREASURY_SECRET).toBeUndefined();
    expect(e.PYTH_API_KEY).toBeUndefined();
  });

  it("accepts PYTH_API_KEY for authenticated Hermes", () => {
    const e = parseEnv({ PYTH_API_KEY: "pyth-test-key" });
    expect(e.PYTH_API_KEY).toBe("pyth-test-key");
  });

  it("accepts a provided TREASURY_SECRET and WITHDRAW_POLL_MS", () => {
    const e = parseEnv({ TREASURY_SECRET: "[1,2,3]", WITHDRAW_POLL_MS: "1500" });
    expect(e.TREASURY_SECRET).toBe("[1,2,3]");
    expect(e.WITHDRAW_POLL_MS).toBe(1500);
  });
});

describe("env TREASURY_SECRET requires TREASURY_OWNER_PUBKEY (real money)", () => {
  const PUBKEY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // any valid 32+ char base58
  const realMoneyBase = {
    REAL_MONEY_ENABLED: "true",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    USDC_MINT: PUBKEY,
    TREASURY_USDC_ATA: PUBKEY,
  };

  it("throws with a truthful message when TREASURY_SECRET is set but TREASURY_OWNER_PUBKEY is missing", () => {
    expect(() => parseEnv({ ...realMoneyBase, TREASURY_SECRET: "[1,2,3]" })).toThrow(
      /TREASURY_OWNER_PUBKEY is required when TREASURY_SECRET is set/,
    );
  });

  it("passes when both TREASURY_SECRET and TREASURY_OWNER_PUBKEY are set", () => {
    expect(() =>
      parseEnv({ ...realMoneyBase, TREASURY_SECRET: "[1,2,3]", TREASURY_OWNER_PUBKEY: PUBKEY }),
    ).not.toThrow();
  });
});
