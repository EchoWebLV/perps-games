import { describe, it, expect } from "vitest";
import { Keypair, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";

function memStore() { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) }; }

describe("portToAnchorWallet", () => {
  it("exposes the port address as publicKey and signs via the port", async () => {
    const kp = Keypair.generate();
    const port = createDevKeypairPort({ secretKey: kp.secretKey, store: memStore() });
    await port.connect();
    const wallet = portToAnchorWallet(port);
    expect(wallet.publicKey.toBase58()).toBe(kp.publicKey.toBase58());

    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: PublicKey.default, lamports: 1 }));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = "11111111111111111111111111111111";
    const signed = await wallet.signTransaction(tx);
    expect(signed.signatures[0].signature).not.toBeNull();

    const all = await wallet.signAllTransactions([tx]);
    expect(all).toHaveLength(1);
  });
});
