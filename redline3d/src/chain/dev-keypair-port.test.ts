import { describe, it, expect } from "vitest";
import { Keypair, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { createDevKeypairPort } from "./dev-keypair-port";

// in-memory storage so the test does not touch real localStorage
function memStore() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
}

describe("dev-keypair port", () => {
  it("connects to the persisted keypair address and signs a transaction", async () => {
    const kp = Keypair.generate();
    const port = createDevKeypairPort({ secretKey: kp.secretKey, store: memStore() });
    const { address } = await port.connect();
    expect(address).toBe(kp.publicKey.toBase58());
    expect(port.currentAddress()).toBe(kp.publicKey.toBase58());

    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: PublicKey.default, lamports: 1 }),
    );
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = "11111111111111111111111111111111"; // dummy 32-byte base58
    const signedB64 = await port.signTransaction(tx.serialize({ requireAllSignatures: false }).toString("base64"));
    const signed = Transaction.from(Buffer.from(signedB64, "base64"));
    expect(signed.signatures[0].signature).not.toBeNull();
  });

  it("generates and persists a keypair when none is provided", () => {
    const store = memStore();
    const a = createDevKeypairPort({ store });
    const b = createDevKeypairPort({ store });
    expect(a.currentAddress()).toBe(b.currentAddress()); // same persisted key
  });

  it("signs a message (64-byte ed25519 signature)", async () => {
    const port = createDevKeypairPort({ secretKey: Keypair.generate().secretKey, store: memStore() });
    const sig = await port.signMessage(new TextEncoder().encode("hello"));
    expect(sig.length).toBe(64);
  });
});
