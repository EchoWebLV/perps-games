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

  it("is deterministic across >1 embedded solana wallets (earliest-verified wins) and alerts", () => {
    let alerted = 0;
    const picked = pickEmbeddedSolanaWallet([emb("Bbb", 200), emb("Aaa", 100)] as any, () => { alerted++; });
    expect(picked).toBe("Aaa");
    expect(alerted).toBe(1);
  });

  it("falls back to address order when timestamps are equal/absent", () => {
    expect(pickEmbeddedSolanaWallet([emb("Zzz"), emb("Aaa")] as any)).toBe("Aaa");
  });
});
