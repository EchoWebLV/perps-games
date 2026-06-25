import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("env withdraw send-leg vars", () => {
  it("defaults WITHDRAW_POLL_MS and leaves TREASURY_SECRET undefined", () => {
    const e = parseEnv({});
    expect(e.WITHDRAW_POLL_MS).toBe(4000);
    expect(e.TREASURY_SECRET).toBeUndefined();
  });

  it("accepts a provided TREASURY_SECRET and WITHDRAW_POLL_MS", () => {
    const e = parseEnv({ TREASURY_SECRET: "[1,2,3]", WITHDRAW_POLL_MS: "1500" });
    expect(e.TREASURY_SECRET).toBe("[1,2,3]");
    expect(e.WITHDRAW_POLL_MS).toBe(1500);
  });
});
