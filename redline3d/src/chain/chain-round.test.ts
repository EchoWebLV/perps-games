import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveRaiderPdas, rawToHuman } from "./chain-round";

describe("chain-round pure helpers", () => {
  it("derives the same PDAs the program expects", () => {
    const owner = new PublicKey("FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM");
    const mint = new PublicKey("3TDF3grFqPJEdX4BhoCYzZuiRG6wrhKYE89wxoEg5kMX");
    const program = new PublicKey("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    const pdas = deriveRaiderPdas(program, owner, mint);
    const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], program);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program);
    const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], program);
    expect(pdas.player.equals(player)).toBe(true);
    expect(pdas.house.equals(house)).toBe(true);
    expect(pdas.round.equals(round)).toBe(true);
  });

  it("converts on-chain raw price + expo to a human float matching the feed scale", () => {
    // entry_raw 5998901507911 with |expo| 8 => ~59989.02 (same scale as feed price)
    expect(rawToHuman(5998901507911, 8)).toBeCloseTo(59989.02, 1);
    expect(rawToHuman(5998901507911, -8)).toBeCloseTo(59989.02, 1); // sign-agnostic
  });
});
