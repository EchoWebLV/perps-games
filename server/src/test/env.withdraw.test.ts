import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";
const base = { DATABASE_URL: "postgres://x" };

describe("withdraw env defaults", () => {
  it("has conservative tiny-cap defaults and threshold 0 (all withdrawals need approval)", () => {
    const e = parseEnv({ ...base } as any);
    expect(e.WITHDRAW_MIN_CENTS).toBe(100);
    expect(e.WITHDRAW_MAX_CENTS).toBe(500);
    expect(e.WITHDRAW_USER_DAILY_CAP_CENTS).toBe(2000);
    expect(e.WITHDRAW_GLOBAL_DAILY_CAP_CENTS).toBe(20000);
    expect(e.WITHDRAW_HOLD_HOURS).toBe(24);
    expect(e.WITHDRAW_QUORUM_THRESHOLD_CENTS).toBe(0);
  });
});
