import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";

describe("parseEnv auth flags", () => {
  it("DEV_AUTH defaults on, and off only when explicitly 'false'", () => {
    expect(parseEnv({}).DEV_AUTH).toBe(true);
    expect(parseEnv({ DEV_AUTH: "false" }).DEV_AUTH).toBe(false);
  });
  it("passes Privy keys through (optional)", () => {
    const e = parseEnv({ PRIVY_APP_ID: "cmtest", PRIVY_APP_SECRET: "sk" });
    expect(e.PRIVY_APP_ID).toBe("cmtest");
    expect(e.PRIVY_APP_SECRET).toBe("sk");
    expect(parseEnv({}).PRIVY_APP_ID).toBeUndefined();
  });
  it("requires SESSION_SECRET in production", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrowError(/SESSION_SECRET is required in production/);
  });
  it("accepts a 32 character SESSION_SECRET in production", () => {
    const e = parseEnv({ NODE_ENV: "production", SESSION_SECRET: "s".repeat(32) });
    expect(e.SESSION_SECRET).toBe("s".repeat(32));
  });
});
