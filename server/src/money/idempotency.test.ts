import { describe, it, expect } from "vitest";
import { WITHDRAW_IDEMPOTENCY_PREFIX, withdrawIdempotencyKey } from "./idempotency.js";

describe("withdrawIdempotencyKey", () => {
  it("is the deterministic 'withdraw:'||id form the row persists before broadcast (spec §6.2)", () => {
    expect(WITHDRAW_IDEMPOTENCY_PREFIX).toBe("withdraw:");
    expect(withdrawIdempotencyKey("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "withdraw:550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("is deterministic — same id always yields the same key (no randomness/auto-key)", () => {
    const id = "abc-123";
    expect(withdrawIdempotencyKey(id)).toBe(withdrawIdempotencyKey(id));
  });

  it("embeds the id verbatim (byte-identical to the stored withdrawalId)", () => {
    // No trimming/normalizing: the key must exactly match what the reserve tx persisted.
    expect(withdrawIdempotencyKey("Abc-XYZ_0")).toBe("withdraw:Abc-XYZ_0");
  });

  it("distinct withdrawal ids never collide (collision = double-send risk)", () => {
    expect(withdrawIdempotencyKey("a")).not.toBe(withdrawIdempotencyKey("b"));
  });

  it("THROWS on an empty/whitespace id (a blank key would collide across withdrawals)", () => {
    expect(() => withdrawIdempotencyKey("")).toThrow(/non-empty/i);
    expect(() => withdrawIdempotencyKey("   ")).toThrow(/non-empty/i);
    expect(() => withdrawIdempotencyKey(undefined as unknown as string)).toThrow(/non-empty/i);
  });
});
