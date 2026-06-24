import { describe, it, expect } from "vitest";
import { pickEmbeddedSolanaWallet } from "./privy-wallet.js";

const emb = (address: string, first_verified_at?: number) => ({
  type: "wallet", chain_type: "solana", connector_type: "embedded", address, first_verified_at,
});

describe("pickEmbeddedSolanaWallet", () => {
  it("returns null when there is no embedded solana wallet", () => {
    expect(pickEmbeddedSolanaWallet([{ type: "email" } as any])).toBeNull();
    expect(pickEmbeddedSolanaWallet([])).toBeNull();
  });

  it("ignores non-embedded and non-solana wallets", () => {
    const accts = [
      { type: "wallet", chain_type: "ethereum", connector_type: "embedded", address: "0xeth" },
      { type: "wallet", chain_type: "solana", connector_type: "injected", address: "Phantom" },
      emb("EmbSol"),
    ];
    expect(pickEmbeddedSolanaWallet(accts as any)).toBe("EmbSol");
  });

  it("does NOT alert when there is exactly one embedded solana wallet", () => {
    const calls: number[] = [];
    expect(pickEmbeddedSolanaWallet([emb("OnlyOne", 100)] as any, (n) => calls.push(n))).toBe("OnlyOne");
    expect(calls).toEqual([]);
  });

  it("is deterministic across >1 embedded solana wallets (earliest-verified wins) and alerts with the count", () => {
    const calls: number[] = [];
    const picked = pickEmbeddedSolanaWallet([emb("Bbb", 200), emb("Aaa", 100)] as any, (n) => calls.push(n));
    expect(picked).toBe("Aaa");
    expect(calls).toEqual([2]); // fired exactly once, with the true count
  });

  it("prefers the client-selected embedded wallet when Privy confirms it belongs to the user", () => {
    const picked = pickEmbeddedSolanaWallet([emb("OldWallet", 100), emb("CurrentWallet", 200)] as any, undefined, "CurrentWallet");
    expect(picked).toBe("CurrentWallet");
  });

  it("ignores a preferred wallet that is not one of the user's embedded wallets", () => {
    const picked = pickEmbeddedSolanaWallet([emb("OldWallet", 100), emb("CurrentWallet", 200)] as any, undefined, "InjectedWallet");
    expect(picked).toBe("OldWallet");
  });

  it("falls back to address order when timestamps are equal/absent (input-order-independent)", () => {
    expect(pickEmbeddedSolanaWallet([emb("Zzz"), emb("Aaa")] as any)).toBe("Aaa");
    expect(pickEmbeddedSolanaWallet([emb("Aaa"), emb("Zzz")] as any)).toBe("Aaa");
  });
});
