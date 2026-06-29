import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WSOL_MINT, buildWrapIxs, buildUnwrapIxs } from "./wsol";

describe("wsol wrap/unwrap", () => {
  const owner = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(WSOL_MINT, owner);

  it("wrap creates ATA when missing, funds it, syncs native", () => {
    const ixs = buildWrapIxs({ owner, lamports: 50_000_000n, ataExists: false });
    expect(ixs.length).toBe(3); // create ATA, transfer, syncNative
    const transfer = ixs[1];
    expect(transfer.keys.some((k) => k.pubkey.equals(ata))).toBe(true);
  });

  it("wrap skips ATA creation when it already exists", () => {
    const ixs = buildWrapIxs({ owner, lamports: 50_000_000n, ataExists: true });
    expect(ixs.length).toBe(2); // transfer, syncNative
  });

  it("unwrap closes the wSOL ATA back to the owner", () => {
    const ixs = buildUnwrapIxs({ owner });
    expect(ixs.length).toBe(1);
    expect(ixs[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[0].keys.some((k) => k.pubkey.equals(ata))).toBe(true);
  });
});
