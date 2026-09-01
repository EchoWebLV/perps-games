import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletBinding } from "./wallet-binding.js";

describe("createWalletBinding", () => {
  it("verifies the wallet signature for the challenge message", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    const wallet = bs58.encode(publicKey);
    const binding = createWalletBinding({ secret: "b".repeat(32), now: () => 1000 });
    const challenge = binding.createChallenge({ userId: "user-1", wallet });
    expect(challenge.message).toMatch(/^Perps Rider wallet binding\n/);
    const signatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(challenge.message), secretKey),
    );

    const verified = await binding.verifyChallenge({
      challenge: challenge.challenge,
      signatureBase58,
    });

    expect(verified).toEqual({ userId: "user-1", wallet });
  });

  it("rejects a signature from another wallet", async () => {
    const secretA = ed.utils.randomSecretKey();
    const secretB = ed.utils.randomSecretKey();
    const wallet = bs58.encode(await ed.getPublicKeyAsync(secretA));
    const binding = createWalletBinding({ secret: "b".repeat(32), now: () => 1000 });
    const challenge = binding.createChallenge({ userId: "user-1", wallet });
    const signatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(challenge.message), secretB),
    );

    await expect(
      binding.verifyChallenge({ challenge: challenge.challenge, signatureBase58 }),
    ).resolves.toBeNull();
  });

  it("rejects an expired challenge", async () => {
    let now = 1000;
    const secretKey = ed.utils.randomSecretKey();
    const wallet = bs58.encode(await ed.getPublicKeyAsync(secretKey));
    const binding = createWalletBinding({ secret: "b".repeat(32), now: () => now, ttlMs: 10 });
    const challenge = binding.createChallenge({ userId: "user-1", wallet });
    const signatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(challenge.message), secretKey),
    );
    now = 1011;

    await expect(
      binding.verifyChallenge({ challenge: challenge.challenge, signatureBase58 }),
    ).resolves.toBeNull();
  });

  it("rejects a challenge with no signature at all", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const wallet = bs58.encode(await ed.getPublicKeyAsync(secretKey));
    const binding = createWalletBinding({ secret: "b".repeat(32), now: () => 1000 });
    const challenge = binding.createChallenge({ userId: "user-1", wallet });

    await expect(binding.verifyChallenge({ challenge: challenge.challenge })).resolves.toBeNull();
  });
});

describe("createWalletBinding — evm family", () => {
  const key = ("0x" + "7".repeat(64)) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const binding = createWalletBinding({ secret: "s".repeat(32), family: "evm" });

  it("binds a wallet via personal_sign", async () => {
    const c = binding.createChallenge({ userId: "u1", wallet: account.address });
    expect(c.message).toContain(`Wallet: ${account.address.toLowerCase()}`);
    expect(c.wallet).toBe(account.address.toLowerCase());
    const signature = await account.signMessage({ message: c.message });
    const out = await binding.verifyChallenge({ challenge: c.challenge, signature });
    expect(out).toEqual({ userId: "u1", wallet: account.address.toLowerCase() });
  });

  it("rejects a Solana-shaped address", () => {
    expect(() =>
      binding.createChallenge({
        userId: "u1",
        wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      }),
    ).toThrow("invalid_wallet_address");
  });

  it("rejects a signature from a different key", async () => {
    const other = privateKeyToAccount(("0x" + "8".repeat(64)) as `0x${string}`);
    const c = binding.createChallenge({ userId: "u1", wallet: account.address });
    const signature = await other.signMessage({ message: c.message });
    expect(await binding.verifyChallenge({ challenge: c.challenge, signature })).toBeNull();
  });

  it("rejects a malformed signature", async () => {
    const c = binding.createChallenge({ userId: "u1", wallet: account.address });
    expect(await binding.verifyChallenge({ challenge: c.challenge, signature: "0xdead" })).toBeNull();
    expect(await binding.verifyChallenge({ challenge: c.challenge })).toBeNull();
  });

  it("rejects an expired evm challenge", async () => {
    let now = 1000;
    const b = createWalletBinding({ secret: "s".repeat(32), family: "evm", now: () => now, ttlMs: 10 });
    const c = b.createChallenge({ userId: "u1", wallet: account.address });
    const signature = await account.signMessage({ message: c.message });
    now = 1011;
    expect(await b.verifyChallenge({ challenge: c.challenge, signature })).toBeNull();
  });

  it("rejects an evm-shaped address on the default (solana) family", () => {
    const solana = createWalletBinding({ secret: "s".repeat(32) });
    expect(() => solana.createChallenge({ userId: "u1", wallet: account.address })).toThrow(
      "invalid_wallet_address",
    );
  });
});
