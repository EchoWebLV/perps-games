import { describe, expect, it, vi } from "vitest";
import { settleWithTimeout } from "./signing-timeout";

describe("settleWithTimeout", () => {
  it("returns the resolved value when the signer finishes before the timeout", async () => {
    const out = await settleWithTimeout(Promise.resolve("sig"), 100, async () => {});

    expect(out).toEqual({ status: "resolved", value: "sig" });
  });

  it("returns timeout when the signer promise does not settle", async () => {
    const onTimeout = vi.fn();

    const out = await settleWithTimeout(new Promise<string>(() => {}), 100, async () => {}, onTimeout);

    expect(out).toEqual({ status: "timeout" });
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("returns rejection without throwing so late signer errors cannot strand the UI", async () => {
    const out = await settleWithTimeout(Promise.reject(new Error("rejected")), 100, async () => {});

    expect(out.status).toBe("rejected");
    if (out.status === "rejected") expect(String(out.error)).toContain("rejected");
  });
});
