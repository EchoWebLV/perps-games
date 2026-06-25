import { describe, expect, it } from "vitest";
import { makeDepositIntents } from "./deposit-intents.js";

describe("makeDepositIntents", () => {
  it("creates and verifies a signed deposit intent", () => {
    const intents = makeDepositIntents({ secret: "i".repeat(32), now: () => 1000 });
    const issued = intents.create({
      userId: "user-1",
      wallet: "Wallet1111111111111111111111111111111111",
      amountCents: 250,
      txBase64: "tx-base64",
    });

    expect(issued.depositIntent.startsWith("v1.")).toBe(true);
    expect(intents.verify(issued.depositIntent)).toEqual({
      userId: "user-1",
      wallet: "Wallet1111111111111111111111111111111111",
      amountCents: 250,
      txBase64: "tx-base64",
    });
  });

  it("rejects a tampered intent", () => {
    const intents = makeDepositIntents({ secret: "i".repeat(32), now: () => 1000 });
    const issued = intents.create({
      userId: "user-1",
      wallet: "Wallet1111111111111111111111111111111111",
      amountCents: 250,
      txBase64: "tx-base64",
    });
    const parts = issued.depositIntent.split(".");
    const tampered = `${parts[0]}.${parts[1].replace(/.$/, parts[1].endsWith("a") ? "b" : "a")}.${parts[2]}`;
    expect(intents.verify(tampered)).toBeNull();
  });

  it("rejects an expired intent", () => {
    let now = 1000;
    const intents = makeDepositIntents({ secret: "i".repeat(32), now: () => now, ttlMs: 10 });
    const issued = intents.create({
      userId: "user-1",
      wallet: "Wallet1111111111111111111111111111111111",
      amountCents: 250,
      txBase64: "tx-base64",
    });
    now = 1011;
    expect(intents.verify(issued.depositIntent)).toBeNull();
  });
});
