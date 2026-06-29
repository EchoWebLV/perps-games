import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveRaiderPdas, rawToHuman, roundToSnap, actionResultFromSnap } from "./chain-round";

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

  it("roundToSnap maps an anchor-decoded round to a typed snapshot (BN -> bigint, raw -> human)", () => {
    const fake = {
      status: 1, outcome: 0, payout: { toString: () => "0" }, banked: { toString: () => "-50000" },
      dir: -1, lev: 2000, entryRaw: { toString: () => "5921756678227" }, entryExpo: 8,
      exitRaw: { toString: () => "0" }, deadlineTs: 1751000000,
    };
    const s = roundToSnap(fake);
    expect(s.status).toBe(1);
    expect(s.dir).toBe(-1);
    expect(s.lev).toBe(2000);
    expect(s.banked).toBe(-50000n); // i128 can be negative
    expect(s.outcomeName).toBe("cashout");
    expect(s.entryHuman).toBeCloseTo(59217.57, 1);
  });

  it("actionResultFromSnap exposes the settled payload only when status==2", () => {
    const base = {
      status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 123n, dir: 1, lev: 100,
      entryRaw: 0n, entryExpo: 8, entryHuman: 59000, exitRaw: 0n, exitHuman: 0, deadlineTs: 0,
    };
    const open = actionResultFromSnap(base, 0n);
    expect(open.settled).toBe(false);
    if (!open.settled) { expect(open.dir).toBe(1); expect(open.banked).toBe(123n); }
    const done = actionResultFromSnap({ ...base, status: 2, outcome: 2, outcomeName: "liq" }, 4_000_000n);
    expect(done.settled).toBe(true);
    if (done.settled) { expect(done.outcomeName).toBe("liq"); expect(done.balance).toBe(4_000_000n); }
  });
});
