import { describe, it, expect } from "vitest";
import { createNullSigner } from "./appsigner";

describe("AppSigner (dev-null)", () => {
  it("has no key and refuses to sign until the money phase", async () => {
    const s = createNullSigner();
    expect(s.backend).toBe("dev-null");
    expect(s.publicKey()).toBeNull();
    await expect(s.signMessage(new Uint8Array([1]))).rejects.toThrow(/money phase/);
    await expect(s.signTransaction({})).rejects.toThrow(/money phase/);
  });
});
