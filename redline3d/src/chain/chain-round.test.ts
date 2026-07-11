import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveRaiderPdas, rawToHuman, roundToSnap, actionResultFromSnap, maxPayoutBase, roundKey, HIGHWAY_DURATION_SENTINEL, HIGHWAY_CRANK_ITERATIONS, isHighwayRound } from "./chain-round";
import { classifyDelegateState, DelegateBusyError } from "./chain-round";
import { CHAIN } from "./config";

describe("chain-round pure helpers", () => {
  it("identifies open-ended Highway rounds and defines one day of crank coverage", () => {
    expect(HIGHWAY_DURATION_SENTINEL).toBe(-1);
    expect(HIGHWAY_CRANK_ITERATIONS).toBe(86_400);
    expect(isHighwayRound({ status: 1, deadlineTs: -123 })).toBe(true);
    expect(isHighwayRound({ status: 2, deadlineTs: -123 })).toBe(false);
    expect(isHighwayRound({ status: 1, deadlineTs: 123 })).toBe(false);
  });

  it("derives master, till, and the per-player PDAs the program expects", () => {
    const owner = new PublicKey("FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM");
    const mint = new PublicKey("3TDF3grFqPJEdX4BhoCYzZuiRG6wrhKYE89wxoEg5kMX");
    const program = new PublicKey("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    const pdas = deriveRaiderPdas(program, owner, mint);
    const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], program);
    const [master] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program);
    const [till] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer(), owner.toBuffer()], program);
    const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], program);
    expect(pdas.player.equals(player)).toBe(true);
    expect(pdas.master.equals(master)).toBe(true);
    expect(pdas.till.equals(till)).toBe(true);
    expect(pdas.round.equals(round)).toBe(true);
    expect(pdas.master.equals(pdas.till)).toBe(false); // master and till are distinct accounts
  });

  it("maxPayoutBase mirrors settle::max_payout (stake × 23.75)", () => {
    expect(maxPayoutBase(10_000_000)).toBe(237_500_000);   // 0.01 SOL → 0.2375 SOL
    expect(maxPayoutBase(100_000_000)).toBe(2_375_000_000); // 0.10 SOL → 2.375 SOL
  });

  it("converts on-chain raw price + expo to a human float matching the feed scale", () => {
    // entry_raw 5998901507911 with |expo| 8 => ~59989.02 (same scale as feed price)
    expect(rawToHuman(5998901507911, 8)).toBeCloseTo(59989.02, 1);
    expect(rawToHuman(5998901507911, -8)).toBeCloseTo(59989.02, 1); // sign-agnostic
  });

  it("roundToSnap maps an anchor-decoded round to a typed snapshot (BN -> bigint, raw -> human)", () => {
    const fake = {
      status: 1, outcome: 0, payout: { toString: () => "0" }, banked: { toString: () => "-50000" },
      stake: { toString: () => "10000000" }, feed: new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
      dir: -1, lev: 2000, entryRaw: { toString: () => "5921756678227" }, entryExpo: 8,
      exitRaw: { toString: () => "0" }, deadlineTs: 1751000000,
    };
    const s = roundToSnap(fake);
    expect(s.status).toBe(1);
    expect(s.dir).toBe(-1);
    expect(s.lev).toBe(2000);
    expect(s.banked).toBe(-50000n); // i128 can be negative
    expect(s.stake).toBe(10_000_000n);
    expect(s.feed).toBe("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
    expect(s.outcomeName).toBe("cashout");
    expect(s.entryHuman).toBeCloseTo(59217.57, 1);
  });

  it("roundKey identifies a round by owner + deadline_ts ONLY — a re-anchored entry MUST NOT change it", () => {
    // Contract change (P0 fix): flip/lever REWRITE entry_raw/entry_expo on-chain (the mid-round
    // re-anchor); deadline_ts is written once at open and never again. Keying identity on the entry
    // snapshot made every post-flip settle look like a stale corpse — poll() discarded genuine
    // settles and rounds never closed. Identity is owner+deadline_ts, immutable for the round's life,
    // so the SAME round keeps ONE key across every re-anchor.
    const dl = 1_751_000_060;
    const atOpen = { entryTs: 1_751_000_000, entryRaw: 8_100_000_000n, deadlineTs: dl };
    const flipped = { entryTs: 1_751_000_000, entryRaw: 8_100_500_000n, deadlineTs: dl }; // entry re-anchored by a flip
    const levered = { entryTs: 1_751_000_000, entryRaw: 7_900_000_000n, deadlineTs: dl }; // and again by a lever
    expect(roundKey(flipped, "Owner1111")).toBe(roundKey(atOpen, "Owner1111")); // was the bug: these keys differed
    expect(roundKey(levered, "Owner1111")).toBe(roundKey(atOpen, "Owner1111"));
  });

  it("roundKey still keys DIFFERENT rounds apart by deadline_ts and by owner", () => {
    // Per-owner rounds are strictly serial (one Round PDA, each open gated on the prior settle), so
    // consecutive rounds never share a deadline second — deadline still separates THIS round from the
    // previous round's settled corpse (the stale-corpse guard the key exists for).
    const r = { entryTs: 111, entryRaw: 222n, deadlineTs: 333 };
    const next = { entryTs: 999, entryRaw: 888n, deadlineTs: 334 }; // the serially-next round (later deadline)
    expect(roundKey(r, "OwnerA")).toBe(roundKey(r, "OwnerA"));        // same round → same key
    expect(roundKey(r, "OwnerA")).not.toBe(roundKey(next, "OwnerA")); // next round → different key
    expect(roundKey(r, "OwnerA")).not.toBe(roundKey(r, "OwnerB"));    // different owner → different key
  });

  it("roundKey needs only deadline_ts (a settled corpse missing the entry snapshot still keys correctly)", () => {
    // flip/lever settled corpses may omit entryTs/entryRaw; identity no longer reads them, so a
    // bare { deadlineTs } keys exactly like the full round object.
    const full = { entryTs: 5, entryRaw: 9n, deadlineTs: 1000 };
    const bare = { deadlineTs: 1000 };
    expect(roundKey(bare, "O")).toBe(roundKey(full, "O"));                     // entry fields ignored → same key
    expect(roundKey(bare, "O")).not.toBe(roundKey({ deadlineTs: 2000 }, "O")); // deadline still distinguishes
  });

  it("actionResultFromSnap exposes the settled payload only when status==2", () => {
    const base = {
      status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 123n, dir: 1, lev: 100,
      entryRaw: 0n, entryExpo: 8, entryHuman: 59000, entryTs: 0, exitRaw: 0n, exitHuman: 0, deadlineTs: 0,
    };
    const open = actionResultFromSnap(base, 0n);
    expect(open.settled).toBe(false);
    if (!open.settled) { expect(open.dir).toBe(1); expect(open.banked).toBe(123n); }
    const done = actionResultFromSnap({ ...base, status: 2, outcome: 2, outcomeName: "liq" }, 4_000_000n);
    expect(done.settled).toBe(true);
    if (done.settled) { expect(done.outcomeName).toBe("liq"); expect(done.balance).toBe(4_000_000n); }
  });
});

describe("classifyDelegateState", () => {
  const DEL = CHAIN.DELEGATION_PROGRAM;
  const PROG = CHAIN.PROGRAM_ID;

  it("reuse when all three delegated accounts are already delegated (our own live session)", () => {
    expect(classifyDelegateState({ player: DEL, till: DEL, round: DEL })).toBe("reuse");
  });

  it("fresh when none are delegated (nulls allowed for not-yet-created PDAs)", () => {
    expect(classifyDelegateState({ player: null, till: PROG, round: null })).toBe("fresh");
    expect(classifyDelegateState({ player: PROG, till: PROG, round: PROG })).toBe("fresh");
  });

  it("busy only on a torn mid-delegation (the per-session till can't be foreign-held)", () => {
    expect(classifyDelegateState({ player: DEL, till: DEL, round: PROG })).toBe("busy");
  });

  it("DelegateBusyError carries a typed code", () => {
    const e = new DelegateBusyError("nope");
    expect(e.code).toBe("delegate_busy");
    expect(e.message).toBe("nope");
  });
});
