import { describe, expect, it } from "vitest";
import { inboundFromTransaction } from "./deposit-source.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY_ATA = "TreasuryAta111111111111111111111111111111";
const ACTUAL_SOURCE_ATA = "ActualSourceAta111111111111111111111111111";
const OTHER_SOURCE_ATA = "OtherSourceAta1111111111111111111111111111";

describe("inboundFromTransaction", () => {
  it("attributes the source owner from the SPL Token transfer into the treasury ATA", () => {
    const tx = {
      meta: {
        err: null,
        preTokenBalances: [
          tokenBalance(0, USDC, "TREASURY_OWNER", 0n),
          tokenBalance(2, USDC, "WALLET_WRONG", 10_000_000n),
          tokenBalance(1, USDC, "WALLET_RIGHT", 5_000_000n),
        ],
        postTokenBalances: [
          tokenBalance(0, USDC, "TREASURY_OWNER", 2_000_000n),
          tokenBalance(2, USDC, "WALLET_WRONG", 9_000_000n),
          tokenBalance(1, USDC, "WALLET_RIGHT", 3_000_000n),
        ],
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: TREASURY_ATA },
            { pubkey: ACTUAL_SOURCE_ATA },
            { pubkey: OTHER_SOURCE_ATA },
            { pubkey: "UnrelatedDest111111111111111111111111111" },
          ],
          instructions: [
            tokenInstruction("transfer", {
              source: OTHER_SOURCE_ATA,
              destination: "UnrelatedDest111111111111111111111111111",
              amount: "1000000",
            }),
            tokenInstruction("transferChecked", {
              source: ACTUAL_SOURCE_ATA,
              destination: TREASURY_ATA,
              mint: USDC,
              tokenAmount: { amount: "2000000", decimals: 6, uiAmount: 2, uiAmountString: "2" },
            }),
          ],
        },
      },
    };

    expect(inboundFromTransaction("sig1", 12, tx, TREASURY_ATA)).toEqual({
      txSig: "sig1",
      slot: 12,
      finalized: true,
      mint: USDC,
      tokenProgram: LEGACY_TOKEN_PROGRAM,
      destAta: TREASURY_ATA,
      sourceOwner: "WALLET_RIGHT",
      amountBaseUnits: 2_000_000n,
    });
  });

  it("ignores treasury transfer instructions whose parsed amount does not match the treasury delta", () => {
    const tx = {
      meta: {
        err: null,
        preTokenBalances: [
          tokenBalance(0, USDC, "TREASURY_OWNER", 0n),
          tokenBalance(1, USDC, "WALLET_RIGHT", 5_000_000n),
        ],
        postTokenBalances: [
          tokenBalance(0, USDC, "TREASURY_OWNER", 2_000_000n),
          tokenBalance(1, USDC, "WALLET_RIGHT", 3_000_000n),
        ],
      },
      transaction: {
        message: {
          accountKeys: [{ pubkey: TREASURY_ATA }, { pubkey: ACTUAL_SOURCE_ATA }],
          instructions: [
            tokenInstruction("transferChecked", {
              source: ACTUAL_SOURCE_ATA,
              destination: TREASURY_ATA,
              mint: USDC,
              tokenAmount: { amount: "1999999", decimals: 6, uiAmount: 1.999999, uiAmountString: "1.999999" },
            }),
          ],
        },
      },
    };

    expect(inboundFromTransaction("sig1", 12, tx, TREASURY_ATA)).toBeNull();
  });
});

function tokenBalance(accountIndex: number, mint: string, owner: string, amount: bigint) {
  return {
    accountIndex,
    mint,
    owner,
    programId: LEGACY_TOKEN_PROGRAM,
    uiTokenAmount: { amount: String(amount) },
  };
}

function tokenInstruction(
  type: "transfer" | "transferChecked",
  info: Record<string, unknown> & { source: string; destination: string; amount?: string },
) {
  return {
    program: "spl-token",
    programId: LEGACY_TOKEN_PROGRAM,
    parsed: {
      type,
      info,
    },
  };
}
