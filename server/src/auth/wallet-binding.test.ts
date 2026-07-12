import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
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
});
