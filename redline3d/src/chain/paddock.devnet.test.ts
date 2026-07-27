// PADDOCK CLIENT vs THE LIVE BOOK — the redline3d client library driving the real wSOL
// book on devnet, end to end: read the shared race, onboard a fresh wallet, bet into the
// pari-mutuel pool, wait out the crank, claim, and check the payout against this file's
// own BigInt mirror of book.rs.
//
// Nothing here calls race_crank. The book's scheduled task drives the phase machine with
// zero client transactions, so every wait below is a POLL — firing the crank ourselves
// would destroy exactly the property these tests depend on.
//
// Gated like the other devnet drivers so it never runs in the unit suite. Run:
//   PADDOCK_DEVNET=1 npx vitest run --config vitest.config.devnet.ts src/chain/paddock.devnet.test.ts
import { describe, it, expect } from "vitest";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import {
  createPaddockBook, findResult, settlePool, settleTicket,
  GRID, PHASE_MARKET, PHASE_RACING, PHASE_SETTLED,
  type OnboardStep, type PaddockBook, type RaceSnap,
} from "./paddock";
import { buildUnwrapIxs } from "./wsol";
import { CHAIN } from "./config";

const RUN = process.env.PADDOCK_DEVNET === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSecs = () => Math.floor(Date.now() / 1000);
const log = (m: string) => { console.log(`      ${m}`); }; // eslint-disable-line no-console

// The live wSOL book, stood up by scripts/paddock-house-setup.mjs.
const BOOK_RACE = "5NfLJyVMRns3uPzuXRJnTdyf2Y9rRwhzg1TTN9QcofVs";
const BOOK_VAULT_TOKEN = "AoNrNMBwY4xP4rQrEDmLWjAYhBohe2dFALesZQfbrDgy";

// The grid the house seeded, car index -> strength (scripts/paddock-house-setup.mjs: the
// client's DEFAULT_GRID roster with rarity strengths x1000). SLOT != CAR: `entrants[i]` is
// the car in slot i, and the crank permutes entrants and strengths TOGETHER on every roll,
// so this table is what proves the odds stayed attached to the right car.
const CAR_STRENGTH = [3200, 2400, 1800, 1800, 1350, 1800, 1000, 1000];

const STAKE = 10_000n;             // 0.00001 SOL per slot — proving mechanics, not volume
const DEPOSIT = 120_000n;          // covers all 8 slots (80_000) with change left over
const FUND_LAMPORTS = 0.07 * LAMPORTS_PER_SOL; // rent for Bettor + Ticket + the delegation CPI

const sortedGrid = () => Array.from({ length: GRID }, (_, i) => i);

/** A book bound to a throwaway keypair. Reads need no funds and never sign. */
function bookFor(kp: Keypair): PaddockBook {
  const port = createDevKeypairPort({ secretKey: kp.secretKey, store: { get: () => null, set: () => {} } });
  return createPaddockBook({ wallet: portToAnchorWallet(port), mint: CHAIN.PADDOCK_BOOK_MINT });
}

/** Poll the ER for a race matching `want`. POLL ONLY — see the header. */
async function waitForRace(book: PaddockBook, label: string, maxSecs: number, want: (r: RaceSnap) => boolean): Promise<RaceSnap> {
  const deadline = Date.now() + maxSecs * 1000;
  let last: RaceSnap | null = null;
  while (Date.now() < deadline) {
    last = await book.raceSnapshot();
    if (last && want(last)) return last;
    await sleep(1000);
  }
  throw new Error(`${label}: not reached in ${maxSecs}s (last seq ${last?.seq} phase ${last?.phase})`);
}

/** A market that is merely OPEN is not enough — MARKET_SECS is 15, and a bet sent into the
 *  tail of one is locked out from under it by the very next crank. Wait for real runway.
 *  (Same reason tests/paddock-e2e.ts:104 has this helper.) */
const waitForFreshMarket = (book: PaddockBook, minSecsLeft: number, maxSecs: number) =>
  waitForRace(book, `market with >${minSecsLeft}s runway`, maxSecs,
    (r) => r.phase === PHASE_MARKET && r.phaseEndsTs - nowSecs() > minSecsLeft);

/** Every snapshot must satisfy this: slot i shows the strength of the car in slot i. */
function expectEntrantStrengthPairing(r: RaceSnap) {
  expect([...r.entrants].sort((a, b) => a - b)).toEqual(sortedGrid());
  for (let i = 0; i < GRID; i++) expect(r.strengths[i]).toBe(CAR_STRENGTH[r.entrants[i]]);
}

/** The invariant the whole design rests on: seed and order are BOTH written by the lock,
 *  in one instruction, so while the market is open neither exists. Verified live: an open
 *  market really does carry a zeroed `order`, not a stale permutation from the last race. */
function expectSeedMatchesPhase(r: RaceSnap) {
  if (r.phase === PHASE_MARKET) {
    expect(r.seed).toEqual(new Uint8Array(32));
    expect(r.order).toEqual(new Array(GRID).fill(0));
  } else {
    expect(r.seed).not.toEqual(new Uint8Array(32));
    expect([...r.order].sort((a, b) => a - b)).toEqual(sortedGrid()); // a permutation
  }
}

describe.skipIf(!RUN)("paddock client vs the live devnet book", () => {
  it("decodes the live race off the ER and watches the scheduled crank move it, untouched", async () => {
    const book = bookFor(Keypair.generate());
    expect(book.pdas.race.toBase58()).toBe(BOOK_RACE);
    expect(book.pdas.vaultToken.toBase58()).toBe(BOOK_VAULT_TOKEN);

    const r = await book.raceSnapshot();
    expect(r).not.toBeNull();
    expect(r!.mint).toBe(CHAIN.PADDOCK_BOOK_MINT.toBase58());
    expect(r!.feed).toBe(CHAIN.BTC_FEED.toBase58());
    expect([PHASE_MARKET, PHASE_RACING, PHASE_SETTLED]).toContain(r!.phase);
    // A live deadline, not a decode of stale bytes: every phase window is under a minute.
    expect(Math.abs(r!.phaseEndsTs - nowSecs())).toBeLessThan(120);
    expect(r!.pools).toHaveLength(GRID);
    expect(r!.total).toBe(r!.pools.reduce((a, p) => a + p, 0n)); // place_bet writes both
    expect(r!.seed).toHaveLength(32);
    expect(r!.history).toHaveLength(32);
    expectSeedMatchesPhase(r!);
    expectEntrantStrengthPairing(r!);
    log(`seq ${r!.seq} phase ${r!.phase} ends in ${r!.phaseEndsTs - nowSecs()}s`);
    log(`entrants [${r!.entrants}] strengths [${r!.strengths}] order [${r!.order}]`);

    // Zero client transactions from here — the scheduled crank alone must move it. The
    // longest window is RACING (40s) + SETTLED (6s), so 90s covers a worst-case entry.
    const k0 = `${r!.seq}:${r!.phase}:${r!.phaseEndsTs}`;
    const moved = await waitForRace(book, "unattended crank movement", 90,
      (x) => `${x.seq}:${x.phase}:${x.phaseEndsTs}` !== k0);
    expectEntrantStrengthPairing(moved);
    expectSeedMatchesPhase(moved);
    log(`crank moved it unattended -> seq ${moved.seq} phase ${moved.phase}`);
  }, 180_000);

  it("onboards a fresh wallet, bets into the shared pool, and claims the mirrored payout", async () => {
    const RPC = process.env.BASE_RPC || CHAIN.BASE_RPC;
    const conn = new Connection(RPC, { commitment: "confirmed" });
    // The house wallet, which holds devnet SOL. (Anchor.toml's lazer-probe.json is at 0.)
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));

    const player = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
      fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: FUND_LAMPORTS,
    })), [funder], { commitment: "confirmed" });
    const book = bookFor(player);
    log(`player ${book.address} funded with ${FUND_LAMPORTS / LAMPORTS_PER_SOL} SOL`);

    try {
      // --- 1. onboarding: join -> wrap -> deposit -> delegate_bettor, all on L1 ---
      expect(await book.delegationState()).toBe("fresh");
      const steps: OnboardStep[] = [];
      await book.ensureBettor(DEPOSIT, (s) => { steps.push(s); log(`onboard: ${s}`); });
      expect(steps).toEqual(["join", "wrap", "deposit", "delegate", "confirm", "ready"]);
      expect(await book.delegationState()).toBe("reuse");

      const joined = await book.bettorSnapshot();
      expect(joined).not.toBeNull();
      expect(joined!.balance).toBe(DEPOSIT);
      expect(joined!.stakes).toEqual(new Array(GRID).fill(0n));
      expect(joined!.raceSeq).toBeNull(); // u64::MAX at join, reported as "no race"

      // A second call is a no-op: every step is already done.
      const again: OnboardStep[] = [];
      await book.ensureBettor(DEPOSIT, (s) => again.push(s));
      expect(again).toEqual(["ready"]);

      // --- 2. bet into a market with real runway ---
      const open = await waitForFreshMarket(book, 10, 150);
      const bettingSeq = open.seq;
      const before = open.pools[0];
      log(`market seq ${bettingSeq}, ${open.phaseEndsTs - nowSecs()}s left, pools [${open.pools}]`);

      // One bet, alone, so its effect is unambiguous: pools[slot] and total each move by
      // exactly the stake. `carId` is a SLOT index, not a car id.
      await book.placeBet(0, STAKE);
      const bet = await book.raceSnapshot();
      expect(bet!.seq).toBe(bettingSeq); // the race must not have rolled under the bet
      expect(bet!.pools[0]).toBe(before + STAKE);
      expect(bet!.total).toBe(open.total + STAKE);
      expectSeedMatchesPhase(bet!); // the bet landed before any seed existed

      const afterBet = await book.bettorSnapshot();
      expect(afterBet!.balance).toBe(DEPOSIT - STAKE);
      expect(afterBet!.stakes[0]).toBe(STAKE);
      expect(afterBet!.raceSeq).toBe(bettingSeq); // the ticket adopted this race

      // Cover the other seven slots so the claim path is reached whichever slot wins.
      // Concurrent, inside one market window — also the shared-pool write-contention check.
      await Promise.all(sortedGrid().slice(1).map((slot) => book.placeBet(slot, STAKE)));
      const covered = await book.raceSnapshot();
      expect(covered!.seq).toBe(bettingSeq);
      for (const slot of sortedGrid()) expect(covered!.pools[slot]).toBe(open.pools[slot] + STAKE);
      expect(covered!.total).toBe(open.total + STAKE * BigInt(GRID)); // no lost update
      const mine = await book.bettorSnapshot();
      expect(mine!.stakes).toEqual(new Array(GRID).fill(STAKE));
      expect(mine!.balance).toBe(DEPOSIT - STAKE * BigInt(GRID));
      log(`8 slots covered at ${STAKE} each; pool total ${covered!.total}`);

      // --- 3. the crank locks, runs and settles it. POLL ONLY. ---
      // The anti-grinding gate can slide phase_ends_ts forward in 2s bands while it waits for
      // a price published inside one, so the lock is not pinned to the original deadline.
      const locked = await waitForRace(book, "lock", 60, (r) => r.seq > bettingSeq || r.phase !== PHASE_MARKET);
      expect(locked.seq).toBe(bettingSeq); // still our race — a roll here means the bets missed
      expect(locked.phase).toBe(PHASE_RACING);
      expectSeedMatchesPhase(locked); // the seed and the order exist only after the lock
      expectEntrantStrengthPairing(locked);
      // Pools are final at the lock; the mirror runs against OBSERVED state, never assumed
      // constants, so a stranger's bet lands in the math instead of faking a settle bug.
      const finalPools = locked.pools, finalTotal = locked.total, rakeAtLock = locked.rakeAccrued;
      const lockedEntrants = locked.entrants; // valid for THIS race only — the roll permutes it
      log(`locked seq ${bettingSeq}: total ${finalTotal}, order [${locked.order}]`);

      const settled = await waitForRace(book, "settle", 90, (r) => r.seq > bettingSeq || r.phase === PHASE_SETTLED);
      expect(settled.seq).toBe(bettingSeq);
      const record = findResult(settled.history, bettingSeq);
      expect(record).not.toBeNull();

      // The settlement mirror: multiplier and rake, recomputed from the observed pool.
      const winner = record!.winner; // a SLOT index
      const mirror = settlePool(finalTotal, finalPools[winner]);
      expect(record!.multFp).toBe(mirror.multFp);
      expect(settled.rakeAccrued - rakeAtLock).toBe(mirror.rake);
      log(`settled: winner SLOT ${winner} = car ${lockedEntrants[winner]} (strength ${locked.strengths[winner]}), mult ${record!.multFp}, rake ${mirror.rake}`);

      // --- 4. claim, once the race has rolled (claim requires race_seq != race.seq) ---
      const rolled = await waitForRace(book, "next market", 60, (r) => r.seq > bettingSeq);
      expectEntrantStrengthPairing(rolled);
      log(`rolled to seq ${rolled.seq}; entrants [${lockedEntrants}] -> [${rolled.entrants}]`);

      const preClaim = await book.bettorSnapshot();
      expect(preClaim!.raceSeq).toBe(bettingSeq);
      // What the client says it is owed, from the ring + this ticket alone.
      const owed = settleTicket(rolled.history, preClaim!);
      await book.claim();
      const postClaim = await book.bettorSnapshot();
      expect(postClaim!.balance - preClaim!.balance).toBe(owed); // to the unit
      expect(owed).toBe((STAKE * record!.multFp) / 1_000_000n); // and it is payout_of(stake, mult)
      expect(owed).toBeGreaterThan(0n); // every slot was covered, so the winner was ours

      // --- 5. the sentinel is restored: the ticket belongs to no race again ---
      expect(postClaim!.raceSeq).toBeNull();
      expect(postClaim!.stakes).toEqual(new Array(GRID).fill(0n));
      log(`claimed ${owed} (mirror ${owed}); balance ${preClaim!.balance} -> ${postClaim!.balance}`);
      log(`net across the race: staked ${STAKE * BigInt(GRID)}, returned ${owed}`);
    } finally {
      // Never strand wrapped SOL or faucet funds in a throwaway wallet. The Bettor's play
      // balance stays in the vault: exit_bettor/withdraw are not wired into this client yet.
      const ixs = buildUnwrapIxs({ owner: player.publicKey });
      await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [player], { commitment: "confirmed" })
        .catch(() => undefined); // no wSOL ATA (onboarding failed early) — nothing to close
      const refund = await conn.getBalance(player.publicKey);
      if (refund > 5_000) {
        await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
          fromPubkey: player.publicKey, toPubkey: funder.publicKey, lamports: refund - 5_000,
        })), [player], { commitment: "confirmed" }).catch(() => undefined);
      }
    }
  }, 600_000);
});
