import { describe, expect, it } from "vitest";
import { createRuntimeDb } from "./runtime.js";

describe("createRuntimeDb", () => {
  it("uses in-memory PGlite for local soft-coin dev when DATABASE_URL is absent", async () => {
    const raw = createRuntimeDb({
      databaseUrl: undefined,
      nodeEnv: "development",
      realMoneyEnabled: false,
    });

    expect(raw.driver).toBe("pglite");
    await raw.close();
  });

  it("fails closed when real-money mode has no durable DATABASE_URL", () => {
    expect(() =>
      createRuntimeDb({
        databaseUrl: undefined,
        nodeEnv: "development",
        realMoneyEnabled: true,
      }),
    ).toThrow(/DATABASE_URL is required when REAL_MONEY_ENABLED=true/);
  });

  it("fails closed in production when DATABASE_URL is absent", () => {
    expect(() =>
      createRuntimeDb({
        databaseUrl: undefined,
        nodeEnv: "production",
        realMoneyEnabled: false,
      }),
    ).toThrow(/DATABASE_URL is required in production/);
  });
});
