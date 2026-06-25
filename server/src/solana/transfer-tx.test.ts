import { describe, it, expect } from "vitest";
import { address, AccountRole, compileTransaction } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  buildTransferCheckedMessage,
  buildUnsignedTransferCheckedWireTx,
  type TransferCheckedTxArgs,
} from "./transfer-tx.js";

// USDC mainnet mint (used only as a structural fixture here; real mint is boot-asserted).
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function args(overrides: Partial<TransferCheckedTxArgs> = {}): TransferCheckedTxArgs {
  return {
    source: address("11111111111111111111111111111112"),
    mint: USDC,
    destination: address("11111111111111111111111111111113"),
    authority: address("11111111111111111111111111111114"),
    feePayer: address("11111111111111111111111111111115"),
    amount: 5_000_000n, // $5.00 in USDC base units
    decimals: 6,
    lifetime: { blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: 1000n },
    ...overrides,
  };
}

describe("buildTransferCheckedMessage", () => {
  it("builds a legacy-SPL transferChecked with accounts in [source, mint, destination, authority] order", () => {
    const msg = buildTransferCheckedMessage(args());
    expect(msg.instructions).toHaveLength(1);
    const ix = msg.instructions[0];
    expect(ix.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(ix.accounts?.map((a) => a.address)).toEqual([
      "11111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "11111111111111111111111111111113",
      "11111111111111111111111111111114",
    ]);
  });

  it("reserves the AUTHORITY as a signer slot (regression: a bare Address is a non-signer → invalid tx)", () => {
    const ix = buildTransferCheckedMessage(args()).instructions[0];
    expect(ix.accounts?.[3].role).toBe(AccountRole.READONLY_SIGNER);
  });

  it("sets fee-payer + blockhash lifetime as v0 (server controls the message bytes, spec §5)", () => {
    const msg = buildTransferCheckedMessage(args());
    expect(msg.version).toBe(0);
    expect(msg.feePayer.address).toBe("11111111111111111111111111111115");
    expect(msg.lifetimeConstraint.blockhash).toBe("11111111111111111111111111111111");
  });
});

describe("buildUnsignedTransferCheckedWireTx", () => {
  it("compiles to a base64 tx whose only signer slots are feePayer + authority, both UNSIGNED", () => {
    const wire = buildUnsignedTransferCheckedWireTx(args());
    expect(typeof wire).toBe("string");
    expect(wire.length).toBeGreaterThan(0);
    // Re-compile to inspect the reserved signature slots the signer fills later.
    const compiled = compileTransaction(buildTransferCheckedMessage(args()));
    expect(Object.keys(compiled.signatures).sort()).toEqual(
      ["11111111111111111111111111111114", "11111111111111111111111111111115"].sort(),
    );
    expect(Object.values(compiled.signatures).every((s) => s === null)).toBe(true);
  });

  it("is deterministic — identical args yield identical wire bytes (idempotency-safe to rebuild)", () => {
    expect(buildUnsignedTransferCheckedWireTx(args())).toBe(buildUnsignedTransferCheckedWireTx(args()));
  });

  it("is amount-sensitive — a different amount changes the bytes (no silent reuse)", () => {
    expect(buildUnsignedTransferCheckedWireTx(args({ amount: 5_000_000n }))).not.toBe(
      buildUnsignedTransferCheckedWireTx(args({ amount: 100n })),
    );
  });
});
