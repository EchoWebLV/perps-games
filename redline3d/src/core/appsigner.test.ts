import { describe, it, expect } from "vitest";
import { createExternalWalletSigner, createNullSigner } from "./appsigner";

describe("AppSigner (dev-null)", () => {
  it("has no key and refuses to sign until the money phase", async () => {
    const s = createNullSigner();
    expect(s.backend).toBe("dev-null");
    expect(s.publicKey()).toBeNull();
    await expect(s.signMessage(new Uint8Array([1]))).rejects.toThrow(/money phase/);
    await expect(s.signTransaction({})).rejects.toThrow(/money phase/);
  });
});

describe("AppSigner (external-wallet)", () => {
  it("exposes the connected wallet address and keeps signing dark until the money phase", async () => {
    const s = createExternalWalletSigner("So1anaAddr1111111111111111111111111111111");
    expect(s.backend).toBe("external-wallet");
    expect(s.publicKey()).toBe("So1anaAddr1111111111111111111111111111111");
    await expect(s.signMessage(new Uint8Array([1]))).rejects.toThrow(/money phase/);
    await expect(s.signTransaction({})).rejects.toThrow(/money phase/);
  });
});
