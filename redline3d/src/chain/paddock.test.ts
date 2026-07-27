import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  derivePaddockPdas, classifyBettorDelegation, classifyExit, raceToSnap, ticketToSnap, findResult, settleTicket,
  settlePool, payoutOf, paddockErrorName, PADDOCK_ERROR_NAMES,
  TICKET_NO_RACE, SCALE, RAKE_FP, GRID, HISTORY_LEN, PHASE_MARKET, PHASE_RACING, PHASE_SETTLED,
  type RaceResultSnap, type RaceSnap, type TicketSnap,
} from "./paddock";
import { CHAIN } from "./config";
import idl from "./idl/paddock.json";

const PROGRAM = new PublicKey("3wz2kwDSGZEfdwing4FucjveWunnpiwoYAnKUAbKRh2S");
const OWNER = new PublicKey("FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** A zeroed history ring — bit-identical to 32 copies of `{seq:0, winner:0, mult_fp:0}`,
 *  which is precisely the phantom the find_result HAZARD note warns about. */
const zeroRing = (): RaceResultSnap[] =>
  Array.from({ length: HISTORY_LEN }, () => ({ seq: 0n, winner: 0, multFp: 0n }));

type IdlAccount = { name: string; pda?: { seeds: { kind: string; path?: string }[] } };
const idlAccounts = (ix: string): IdlAccount[] =>
  (idl.instructions.find((i) => i.name === ix)?.accounts ?? []) as unknown as IdlAccount[];
const accountNames = (ix: string) => idlAccounts(ix).map((a) => a.name);
/** The seed sources anchor recorded for one account, in order — `const` for literal seeds,
 *  otherwise the account the seed is read from. This is what proves who a PDA is derived FOR. */
const seedPaths = (ix: string, account: string): string[] =>
  (idlAccounts(ix).find((a) => a.name === account)?.pda?.seeds ?? []).map((s) => s.path ?? "const");

describe("paddock IDL", () => {
  it("is the deployed program ABI with the book's instructions", () => {
    expect(idl.address).toBe("3wz2kwDSGZEfdwing4FucjveWunnpiwoYAnKUAbKRh2S");
    expect(CHAIN.PADDOCK_PROGRAM_ID.toBase58()).toBe(idl.address);
    const names = idl.instructions.map((i) => i.name);
    for (const ix of ["init_book", "join", "deposit", "init_race", "delegate_race", "delegate_bettor", "place_bet", "race_crank", "claim", "commit_race", "exit_bettor", "withdraw"]) {
      expect(names).toContain(ix);
    }
    expect(idl.accounts.map((a) => a.name).sort()).toEqual(["Bettor", "Book", "Race", "Ticket"]);
  });

  it("pins the book's mint to the active stake currency (wSOL)", () => {
    expect(CHAIN.PADDOCK_BOOK_MINT.toBase58()).toBe("So11111111111111111111111111111111111111112");
    expect(CHAIN.PADDOCK_BOOK_MINT.toBase58()).toBe(CHAIN.STAKE_MINT);
  });

  it("names every PaddockError at the code anchor assigns it", () => {
    for (const e of idl.errors) expect(PADDOCK_ERROR_NAMES[e.code]).toBe(e.name);
  });

  it("derives BOTH of exit_bettor's accounts from the SIGNER — the 2ae4b8d access-control fix", () => {
    // The earlier shape seeded `ticket` from `ticket.owner`, which authorises nothing: every
    // legitimate ticket satisfies its own self-referential seeds, so an attacker could pair
    // their bettor with a VICTIM's ticket and undelegate it, splitting the co-delegated pair
    // and blocking the victim's place_bet. If the program ever regresses to that, the IDL
    // says so here — the client's accountsPartial({payer, bettor, ticket}) rides on this.
    expect(seedPaths("exit_bettor", "bettor")).toEqual(["const", "payer", "mint"]);
    expect(seedPaths("exit_bettor", "ticket")).toEqual(["const", "payer", "mint"]);
  });

  it("gives withdraw the same signer-derived Bettor deposit uses, plus the vault pair", () => {
    // withdraw writes the L1 Bettor, which is exactly why it cannot run while the account is
    // delegated — the ordering trap cashOut exists to get right.
    expect(seedPaths("withdraw", "bettor")).toEqual(["const", "owner", "mint"]);
    expect(seedPaths("deposit", "bettor")).toEqual(["const", "owner", "mint"]);
    expect(accountNames("withdraw")).toEqual(accountNames("deposit"));
    expect(accountNames("withdraw")).toContain("vault_token"); // the ATA that custodies stakes
  });
});

describe("derivePaddockPdas", () => {
  it("derives the per-mint singletons and the per-player accounts the program expects", () => {
    const pdas = derivePaddockPdas(PROGRAM, OWNER, MINT);
    const [book] = PublicKey.findProgramAddressSync([Buffer.from("book"), MINT.toBuffer()], PROGRAM);
    const [race] = PublicKey.findProgramAddressSync([Buffer.from("race"), MINT.toBuffer()], PROGRAM);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), MINT.toBuffer()], PROGRAM);
    const [bettor] = PublicKey.findProgramAddressSync([Buffer.from("bettor"), OWNER.toBuffer(), MINT.toBuffer()], PROGRAM);
    const [ticket] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), OWNER.toBuffer(), MINT.toBuffer()], PROGRAM);
    expect(pdas.book.equals(book)).toBe(true);
    expect(pdas.race.equals(race)).toBe(true);
    expect(pdas.vault.equals(vault)).toBe(true);
    expect(pdas.bettor.equals(bettor)).toBe(true);
    expect(pdas.ticket.equals(ticket)).toBe(true);
  });

  it("derives the vault's ATA off the vault AUTHORITY, off-curve", () => {
    const pdas = derivePaddockPdas(PROGRAM, OWNER, MINT);
    // The authority PDA holds nothing; `vaultToken` is the account deposit/withdraw move
    // tokens through, so the split has to be explicit or a deposit aims at the wrong account.
    expect(pdas.vaultToken.equals(getAssociatedTokenAddressSync(MINT, pdas.vault, true))).toBe(true);
    expect(pdas.vaultToken.equals(pdas.vault)).toBe(false);
  });

  it("keys book/race/vault by mint only, and bettor/ticket by owner too", () => {
    const a = derivePaddockPdas(PROGRAM, OWNER, MINT);
    const other = new PublicKey("2Xh6WT5oYqvLnRLGE7RtF9BQtqiVEV88pgvsCcaJoRXR");
    const b = derivePaddockPdas(PROGRAM, other, MINT);
    // Same book, same race, same vault — that shared pool IS the pari-mutuel design.
    expect(b.book.equals(a.book)).toBe(true);
    expect(b.race.equals(a.race)).toBe(true);
    expect(b.vault.equals(a.vault)).toBe(true);
    // Different player, different money.
    expect(b.bettor.equals(a.bettor)).toBe(false);
    expect(b.ticket.equals(a.ticket)).toBe(false);
  });
});

describe("classifyBettorDelegation", () => {
  const DEL = CHAIN.DELEGATION_PROGRAM;
  const PROG = CHAIN.PADDOCK_PROGRAM_ID;

  it("reads a fully delegated pair as reusable", () => {
    expect(classifyBettorDelegation({ bettor: DEL, ticket: DEL })).toBe("reuse");
  });

  it("reads absent PDAs and program-owned PDAs alike as fresh", () => {
    expect(classifyBettorDelegation({ bettor: null, ticket: null })).toBe("fresh");
    expect(classifyBettorDelegation({ bettor: PROG, ticket: PROG })).toBe("fresh");
    // Joined but never delegated: the accounts exist, owned by the program.
    expect(classifyBettorDelegation({ bettor: PROG, ticket: null })).toBe("fresh");
  });

  it("reads a half-delegated pair as busy — the state exit_bettor's access-control bug could force", () => {
    // Bettor and Ticket are delegated by ONE instruction and must be written in ONE ER
    // transaction, so a split pair is not a state to retry into — it needs an exit.
    expect(classifyBettorDelegation({ bettor: DEL, ticket: PROG })).toBe("busy");
    expect(classifyBettorDelegation({ bettor: PROG, ticket: DEL })).toBe("busy");
    expect(classifyBettorDelegation({ bettor: null, ticket: DEL })).toBe("busy");
  });
});

describe("settlePool / payoutOf mirror book.rs to the unit", () => {
  it("matches the paddock e2e's own numbers (300k on the winner out of a 1M pool)", () => {
    // The vector the devnet e2e proved: STAKE_A 300_000 + STAKE_B 700_000 = 1_000_000.
    // rake 50_000 -> payable 950_000 -> 950_000 * 1e6 / 300_000 = 3_166_666.66 -> floor.
    const s = settlePool(1_000_000n, 300_000n);
    expect(s.rake).toBe(50_000n);
    expect(s.multFp).toBe(3_166_666n);
    // 300_000 * 3_166_666 / 1e6 = 949_999.8 -> floor. The 0.2 lost to truncation stays
    // with the house; that is the point of flooring, not a rounding bug.
    expect(payoutOf(300_000n, s.multFp)).toBe(949_999n);
  });

  it("matches book.rs's own unit vectors (400k winner pool)", () => {
    const s = settlePool(1_000_000n, 400_000n);
    expect(s.rake).toBe(50_000n);
    expect(s.multFp).toBe(2_375_000n);
    expect(payoutOf(400_000n, s.multFp)).toBe(950_000n); // divides evenly — no truncation
  });

  it("gives the whole pool to the house when nobody backed the winner", () => {
    const s = settlePool(1_000_000n, 0n);
    expect(s.multFp).toBe(0n);
    expect(s.rake).toBe(1_000_000n);
    expect(payoutOf(0n, s.multFp)).toBe(0n);
  });

  it("settles an empty race to zero", () => {
    expect(settlePool(0n, 0n)).toEqual({ multFp: 0n, rake: 0n });
  });

  it("pays a lone winner the whole payable pool", () => {
    const s = settlePool(1_000_000n, 100n);
    expect(payoutOf(100n, s.multFp)).toBe(950_000n);
  });

  it("never pays out more than the payable pool under floor division", () => {
    // The conservation property book.rs locks: floored payouts leave the house whole.
    const stakes = [333_333n, 333_333n, 333_334n];
    const winnerPool = stakes.reduce((a, b) => a + b, 0n);
    const total = winnerPool + 500_000n;
    const s = settlePool(total, winnerPool);
    const paid = stakes.reduce((a, st) => a + payoutOf(st, s.multFp), 0n);
    expect(paid).toBeLessThanOrEqual(total - s.rake);
  });

  it("does not overflow on pools a u64 could actually hold", () => {
    // BigInt cannot silently wrap, but the u128 widening in book.rs exists for this case —
    // keep the mirror honest against it.
    const total = (2n ** 64n - 1n) / 4n;
    const s = settlePool(total, total / 2n);
    expect(s.multFp).toBeGreaterThan(0n);
    expect(payoutOf(total / 2n, s.multFp)).toBeLessThanOrEqual(total - s.rake);
  });

  it("uses no floats anywhere on the money path", () => {
    expect(SCALE).toBe(1_000_000n);
    expect(RAKE_FP).toBe(50_000n);
    // 5% of the pool, exactly, expressed in the same fixed-point the program uses.
    expect((12_345_678n * RAKE_FP) / SCALE).toBe(617_283n);
  });
});

describe("the u64::MAX ticket sentinel", () => {
  it("is u64::MAX, not a sequence number", () => {
    expect(TICKET_NO_RACE).toBe(18_446_744_073_709_551_615n);
    expect(TICKET_NO_RACE).toBe(2n ** 64n - 1n);
  });

  it("ticketToSnap reports a sentinel ticket as NO active race", () => {
    const t = ticketToSnap({ raceSeq: TICKET_NO_RACE.toString(), stakes: new Array(GRID).fill(0) });
    expect(t.raceSeq).toBeNull();
    expect(t.stakes).toHaveLength(GRID);
  });

  it("ticketToSnap passes a real seq through untouched — including seq 0", () => {
    expect(ticketToSnap({ raceSeq: 0, stakes: new Array(GRID).fill(0) }).raceSeq).toBe(0n);
    expect(ticketToSnap({ raceSeq: "41", stakes: new Array(GRID).fill(0) }).raceSeq).toBe(41n);
  });

  it("findResult refuses to look up a sentinel, so the phantom race 0 can never match", () => {
    // The HAZARD in state.rs: a zeroed slot is bit-identical to {seq:0, winner:0, mult_fp:0},
    // so an unguarded lookup returns Some(..) for race 0 from the moment the account exists.
    const ring = zeroRing();
    expect(findResult(ring, null)).toBeNull();          // sentinel ticket -> no result
    expect(findResult(ring, 0n)).not.toBeNull();        // seq 0 IS in slot 0 — the phantom itself
    expect(findResult(ring, 1n)).toBeNull();            // slot 1 holds seq 0, not 1 -> overwritten
  });

  it("settleTicket credits a sentinel ticket ZERO even against a zeroed ring", () => {
    // A fresh (or already-claimed) ticket must never be paid. It would pay 0 here anyway
    // because the phantom's mult_fp is 0 — settle_ticket's comment says explicitly not to
    // rely on that, so the sentinel is rejected before the lookup, not after.
    const ring = zeroRing();
    const fresh = ticketToSnap({ raceSeq: TICKET_NO_RACE.toString(), stakes: [9_999n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] });
    expect(fresh.raceSeq).toBeNull();
    expect(settleTicket(ring, fresh)).toBe(0n);
  });

  it("settleTicket pays a real winning ticket and zeroes a losing one", () => {
    const ring = zeroRing();
    ring[7] = { seq: 7n, winner: 3, multFp: 3_166_666n };
    const winner = ticketToSnap({ raceSeq: 7, stakes: [0n, 0n, 0n, 300_000n, 0n, 0n, 0n, 0n] });
    const loser = ticketToSnap({ raceSeq: 7, stakes: [300_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] });
    expect(settleTicket(ring, winner)).toBe(949_999n);
    expect(settleTicket(ring, loser)).toBe(0n);
  });

  it("settleTicket pays nothing for a race that aged out of the 32-slot ring", () => {
    // seq 7 and seq 39 share slot 7; once 39 lands, 7's result is gone.
    const ring = zeroRing();
    ring[7] = { seq: 39n, winner: 3, multFp: 3_166_666n };
    const stale = ticketToSnap({ raceSeq: 7, stakes: [0n, 0n, 0n, 300_000n, 0n, 0n, 0n, 0n] });
    expect(findResult(ring, stale.raceSeq)).toBeNull();
    expect(settleTicket(ring, stale)).toBe(0n);
  });
});

describe("classifyExit — what a cash-out owes the ticket before it undelegates", () => {
  /** A race carrying `history`, with everything cashOut does not read left at its zero. */
  const raceAt = (seq: bigint, history: RaceResultSnap[], phase = PHASE_MARKET): RaceSnap => ({
    mint: MINT.toBase58(), seq, phase, phaseEndsTs: 0,
    entrants: [0, 1, 2, 3, 4, 5, 6, 7], strengths: new Array(GRID).fill(1000),
    pools: new Array(GRID).fill(0n), total: 0n, order: new Array(GRID).fill(0),
    seed: new Uint8Array(32), feed: CHAIN.BTC_FEED.toBase58(), rakeAccrued: 0n, history,
  });
  const ticketOn = (raceSeq: bigint | null, slot: number, stake: bigint): TicketSnap => {
    const stakes = new Array<bigint>(GRID).fill(0n);
    stakes[slot] = stake;
    return { raceSeq, stakes };
  };
  const winRing = (seq: bigint, winner: number, multFp: bigint) => {
    const ring = zeroRing();
    ring[Number(seq % BigInt(HISTORY_LEN))] = { seq, winner, multFp };
    return ring;
  };

  it("blocks while the ticket's stakes are riding the race that is running right now", () => {
    // The stakes have already left bettor.balance for race.pools, and only `claim` (ER, needs
    // the Ticket delegated) can bring them back — so exiting strands them.
    expect(classifyExit(raceAt(41n, zeroRing()), ticketOn(41n, 3, 10_000n))).toBe("blocked");
  });

  it("still blocks in SETTLED, when the ring already holds THIS race's winning result", () => {
    // The sharp edge: push_result writes the ring at RACING->SETTLED, so between the settle
    // and the roll a live winning ticket looks claimable to settleTicket — but `claim` rejects
    // it with WrongPhase (race_seq != race.seq). The live check therefore has to come FIRST,
    // or a cash-out in that ~6s window sends a transaction that can only fail.
    const ring = winRing(41n, 3, 3_166_666n);
    expect(settleTicket(ring, ticketOn(41n, 3, 300_000n))).toBeGreaterThan(0n);
    expect(classifyExit(raceAt(41n, ring, PHASE_SETTLED), ticketOn(41n, 3, 300_000n))).toBe("blocked");
  });

  it("claims first when a settled winning ticket is still unclaimed", () => {
    // withdraw pays out bettor.balance and nothing else, so exiting without this hands the
    // player their deposit back and leaves the winnings in the ring to expire.
    const ring = winRing(40n, 3, 3_166_666n);
    expect(classifyExit(raceAt(41n, ring), ticketOn(40n, 3, 300_000n))).toBe("claim");
  });

  it("exits straight away on a losing ticket — a claim that pays 0 buys nothing", () => {
    const ring = winRing(40n, 3, 3_166_666n);
    expect(classifyExit(raceAt(41n, ring), ticketOn(40n, 0, 300_000n))).toBe("exit");
  });

  it("exits straight away on a winning ticket whose race aged out of the 32-slot ring", () => {
    // seq 8 and seq 40 share slot 8; once 40 lands, 8's result is gone and nothing can pay it.
    const ring = winRing(40n, 3, 3_166_666n);
    expect(findResult(ring, 8n)).toBeNull();
    expect(classifyExit(raceAt(41n, ring), ticketOn(8n, 3, 300_000n))).toBe("exit");
  });

  it("exits straight away on the u64::MAX sentinel — fresh, or claimed already", () => {
    expect(classifyExit(raceAt(41n, zeroRing()), ticketOn(null, 0, 0n))).toBe("exit");
    // And the phantom race 0 cannot drag a sentinel ticket into a claim, even at seq 0.
    expect(classifyExit(raceAt(0n, zeroRing()), ticketOn(null, 0, 9_999n))).toBe("exit");
  });

  it("does not block on the live race when every stake is zero", () => {
    // Only a 0-amount bet can produce this, but the guard is about MONEY at risk, not about
    // which seq the ticket happens to name.
    expect(classifyExit(raceAt(41n, zeroRing()), ticketOn(41n, 0, 0n))).toBe("exit");
  });
});

describe("raceToSnap", () => {
  const bn = (s: string | number) => ({ toString: () => String(s) });

  it("maps an anchor-decoded Race to a BN-free snapshot", () => {
    const snap = raceToSnap({
      mint: MINT, seq: bn(41), phase: 1, phaseEndsTs: bn(1_753_600_000),
      entrants: [0, 1, 2, 3, 4, 5, 6, 7], strengths: [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200],
      pools: [bn(300_000), bn(0), bn(0), bn(0), bn(0), bn(0), bn(0), bn(700_000)], total: bn(1_000_000),
      order: [7, 6, 5, 4, 3, 2, 1, 0], seed: new Array(32).fill(9),
      feed: CHAIN.BTC_FEED, rakeAccrued: bn(50_000),
      history: [{ seq: bn(40), winner: 2, multFp: bn(2_375_000) }],
    });
    expect(snap.mint).toBe("So11111111111111111111111111111111111111112");
    expect(snap.seq).toBe(41n);
    expect(snap.phase).toBe(PHASE_RACING);
    expect(snap.phaseEndsTs).toBe(1_753_600_000);
    expect(snap.pools).toEqual([300_000n, 0n, 0n, 0n, 0n, 0n, 0n, 700_000n]);
    expect(snap.total).toBe(1_000_000n);
    expect(snap.order[0]).toBe(7); // order[0] is the winner
    expect(snap.seed).toBeInstanceOf(Uint8Array);
    expect(snap.seed).toHaveLength(32);
    expect(snap.feed).toBe(CHAIN.BTC_FEED.toBase58());
    expect(snap.rakeAccrued).toBe(50_000n);
    expect(snap.history[0]).toEqual({ seq: 40n, winner: 2, multFp: 2_375_000n });
  });

  it("pins the grid width, ring length and phase codes to state.rs", () => {
    expect(GRID).toBe(8);
    expect(HISTORY_LEN).toBe(32);
    expect([PHASE_MARKET, PHASE_RACING, PHASE_SETTLED]).toEqual([0, 1, 2]);
  });
});

describe("paddockErrorName", () => {
  it("names a program error from the hex code a skipPreflight send reports", () => {
    expect(paddockErrorName(new Error("tx 5xy failed: custom program error: 0x1776"))).toBe("WrongPhase");
    expect(paddockErrorName(new Error("custom program error: 0x1774"))).toBe("InsufficientBalance");
  });

  it("names one from the JSON status the confirm poll surfaces", () => {
    expect(paddockErrorName(new Error(`tx 5xy failed: {"InstructionError":[0,{"Custom":6008}]}`))).toBe("NoSuchResult");
  });

  it("returns null for anything that isn't one of ours", () => {
    expect(paddockErrorName(new Error("blockhash not found"))).toBeNull();
    expect(paddockErrorName(new Error("custom program error: 0x1"))).toBeNull(); // not a PaddockError code
  });
});
