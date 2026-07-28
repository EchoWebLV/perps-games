// paddock.ts — client for the pari-mutuel race book. Same shape as chain-round.ts:
// PDA derivation, BN-free snapshots, HTTP-poll sends. Betting lives entirely in the ER
// (Race is delegated permanently; Bettor/Ticket per player), so place_bet/claim target
// CHAIN.ER_RPC, while the one-time onboarding (join / deposit / delegate_bettor) and the
// exit (exit_bettor's undelegation lands there; withdraw / unwrap run there) are L1.
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CHAIN } from "./config";
import { WSOL_MINT, wsolAta, buildWrapIxs, buildUnwrapIxs } from "./wsol";
import idlJson from "./idl/paddock.json";
import type { Paddock } from "./idl/paddock";
import type { AnchorWalletLike } from "./anchor-wallet";
import type { DelegateState } from "./chain-round";

const { BN } = anchor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long `send` waits for a signature to confirm before giving up. A wall-clock budget,
 *  not a poll count: the poll interval varies per call site and RPC round-trip time is not
 *  free, so counting iterations would silently stretch the real deadline. */
const CONFIRM_BUDGET_MS = 60_000;

/** Grid width and the history ring's length — state.rs GRID / HISTORY_LEN. */
export const GRID = 8;
export const HISTORY_LEN = 32;

/** Phase codes (state.rs). MARKET is the only one that accepts a bet. */
export const PHASE_MARKET = 0;
export const PHASE_RACING = 1;
export const PHASE_SETTLED = 2;

/** `Ticket.race_seq` when the ticket belongs to no race: written at `join` and again by
 *  `claim`. It is u64::MAX, NOT a sequence number — see the sentinel note on ticketToSnap. */
export const TICKET_NO_RACE = (1n << 64n) - 1n;

/** book.rs fixed-point constants. 5% rake, 1e6 scale. */
export const SCALE = 1_000_000n;
export const RAKE_FP = 50_000n;

// Anchor hands back BN for u64/i64 and plain numbers for u8/u16; accept either so the
// mappers below stay unit-testable without a chain (same trick as roundToSnap).
type Scalar = number | { toString(): string };
const big = (v: Scalar) => BigInt(v.toString());
const num = (v: Scalar) => Number(v.toString());

export interface PaddockPdas { book: PublicKey; race: PublicKey; vault: PublicKey; vaultToken: PublicKey; bettor: PublicKey; ticket: PublicKey; }

/** Derive the paddock PDAs + the vault ATA for an owner+mint (matches state.rs seeds).
 *  `book`/`race`/`vault` are singletons per mint; `bettor`/`ticket` are per player.
 *  `vault` is the vault AUTHORITY PDA — `vaultToken` is the ATA it owns, the account that
 *  actually custodies stakes (same authority/token split as deriveRaiderPdas). */
export function derivePaddockPdas(programId: PublicKey, owner: PublicKey, mint: PublicKey): PaddockPdas {
  const [book] = PublicKey.findProgramAddressSync([Buffer.from("book"), mint.toBuffer()], programId);
  const [race] = PublicKey.findProgramAddressSync([Buffer.from("race"), mint.toBuffer()], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], programId);
  const vaultToken = getAssociatedTokenAddressSync(mint, vault, true);
  const [bettor] = PublicKey.findProgramAddressSync([Buffer.from("bettor"), owner.toBuffer(), mint.toBuffer()], programId);
  const [ticket] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), owner.toBuffer(), mint.toBuffer()], programId);
  return { book, race, vault, vaultToken, bettor, ticket };
}

/**
 * Classify the co-delegated Bettor/Ticket pair from their L1 owners — the same three-state
 * read chain-round.ts:72 does for a raider session, over the pair `delegate_bettor` moves
 * together:
 *  - both delegated → "reuse" (already onboarded; this wallet can bet right now)
 *  - neither        → "fresh" (nulls = not-yet-created PDAs count as not-delegated)
 *  - one of the two → "busy"  (torn mid-delegation — `delegate_bettor` would re-delegate the
 *                              live half and fail, so it needs an exit, not a retry)
 */
export function classifyBettorDelegation(owners: { bettor: PublicKey | null; ticket: PublicKey | null }): DelegateState {
  const del = (o: PublicKey | null) => !!o && o.equals(CHAIN.DELEGATION_PROGRAM);
  const b = del(owners.bettor), t = del(owners.ticket);
  if (b && t) return "reuse";
  if (!b && !t) return "fresh";
  return "busy";
}

export interface Settlement { multFp: bigint; rake: bigint; }

/** Mirror of book::settle_pool — split `total` into rake and a per-unit multiplier for
 *  stakes on the winner. BigInt division truncates exactly like Rust's u128 division, and
 *  that flooring is the point: the sum of floored payouts can only ever fall short of the
 *  payable pool, never exceed it. No floats anywhere on this path. */
export function settlePool(total: bigint, winnerPool: bigint): Settlement {
  // Nobody backed the winner: no stakes to divide by, no claim can reference this race,
  // so the house takes the pool. Explicit branch, not an accidental divide-by-zero.
  if (winnerPool === 0n) return { multFp: 0n, rake: total };
  const rake = (total * RAKE_FP) / SCALE;
  const payable = total - rake;
  return { multFp: (payable * SCALE) / winnerPool, rake };
}

/** Mirror of book::payout_of — one bettor's gross payout for `stake` on the winning car. */
export const payoutOf = (stake: bigint, multFp: bigint): bigint => (stake * multFp) / SCALE;

export interface RaceResultSnap { seq: bigint; winner: number; multFp: bigint; }

export interface RaceSnap {
  mint: string; seq: bigint; phase: number; phaseEndsTs: number;
  entrants: number[]; strengths: number[]; pools: bigint[]; total: bigint;
  order: number[]; seed: Uint8Array; feed: string; rakeAccrued: bigint;
  history: RaceResultSnap[];
}

export interface TicketSnap {
  stakes: bigint[];
  /** The race this ticket's stakes belong to, or null when it belongs to none.
   *  Never a raw u64::MAX — see ticketToSnap. */
  raceSeq: bigint | null;
}

export interface BettorSnap extends TicketSnap { balance: bigint; }

/** Map an anchor-decoded Race account into a typed, BN-free snapshot. */
export function raceToSnap(r: {
  mint: { toBase58(): string }; seq: Scalar; phase: Scalar; phaseEndsTs: Scalar;
  entrants: number[]; strengths: number[]; pools: Scalar[]; total: Scalar;
  order: number[]; seed: number[]; feed: { toBase58(): string }; rakeAccrued: Scalar;
  history: { seq: Scalar; winner: Scalar; multFp: Scalar }[];
}): RaceSnap {
  return {
    mint: r.mint.toBase58(), seq: big(r.seq), phase: num(r.phase), phaseEndsTs: num(r.phaseEndsTs),
    entrants: r.entrants.map(Number), strengths: r.strengths.map(Number),
    pools: r.pools.map(big), total: big(r.total), order: r.order.map(Number),
    seed: Uint8Array.from(r.seed), feed: r.feed.toBase58(), rakeAccrued: big(r.rakeAccrued),
    history: r.history.map((h) => ({ seq: big(h.seq), winner: num(h.winner), multFp: big(h.multFp) })),
  };
}

/** Map an anchor-decoded Ticket into a snapshot, collapsing the u64::MAX sentinel to null.
 *
 *  This guard is MANDATORY, not defensive tidying. The history ring is zero-initialised and
 *  an all-zero RaceResult is bit-identical to a real `{seq: 0, winner: 0, mult_fp: 0}`, so a
 *  lookup of a sentinel ticket would match the phantom race 0 the moment the account exists
 *  (the HAZARD note on Race::find_result, state.rs). Reporting u64::MAX as if it were a
 *  sequence number is exactly the mistake that note forbids; the program itself guards it in
 *  settle_ticket and rejects it in `claim` with NoSuchResult. */
export function ticketToSnap(t: { raceSeq: Scalar; stakes: Scalar[] }): TicketSnap {
  const raceSeq = big(t.raceSeq);
  return { stakes: t.stakes.map(big), raceSeq: raceSeq === TICKET_NO_RACE ? null : raceSeq };
}

/** Mirror of Race::find_result — the ring is slot-keyed by seq, so a slot whose seq does not
 *  match has been overwritten. Takes `seq: bigint | null` so a sentinel ticket cannot reach it. */
export function findResult(history: RaceResultSnap[], seq: bigint | null): RaceResultSnap | null {
  if (seq === null) return null;
  const r = history[Number(seq % BigInt(HISTORY_LEN))];
  return r && r.seq === seq ? r : null;
}

/** Mirror of lib.rs settle_ticket — what a ticket is owed for the race it references, or 0
 *  if that race aged out of the ring, never settled, or the ticket had nothing on the winner. */
export function settleTicket(history: RaceResultSnap[], ticket: TicketSnap): bigint {
  const result = findResult(history, ticket.raceSeq);
  if (!result) return 0n;
  return payoutOf(ticket.stakes[result.winner] ?? 0n, result.multFp);
}

/** What a cash-out has to do about the ticket before it may undelegate. Pure, so the whole
 *  decision is testable without a chain — same reason classifyBettorDelegation is a free
 *  function rather than a branch buried in ensureBettor.
 *
 *  - "blocked" — the stakes are riding the race running RIGHT NOW. exit_bettor has no phase
 *    check and would commit and undelegate happily, but place_bet already moved that money
 *    out of bettor.balance into race.pools, and the only instruction that can pay it back is
 *    `claim` — which runs in the ER and needs the Ticket delegated. Exiting there does not
 *    lose the bet outright, it STRANDS it: recovery means paying for another delegate_bettor
 *    and claiming before the result falls out of the 32-race ring. Nothing can be claimed
 *    first either, because this race has no result yet, so the only honest answer is to wait.
 *  - "claim" — an unclaimed WINNING ticket from a past race. `withdraw` pays out
 *    bettor.balance and nothing else, so exiting without claiming hands the player their
 *    deposit back and silently leaves the winnings in the ring to expire.
 *  - "exit" — a fresh, losing or aged-out ticket: it settles to 0, so it buys no transaction. */
export type ExitAction = "exit" | "claim" | "blocked";

export function classifyExit(race: RaceSnap, ticket: TicketSnap): ExitAction {
  if (ticket.raceSeq !== null && ticket.raceSeq === race.seq && ticket.stakes.some((s) => s > 0n)) return "blocked";
  return settleTicket(race.history, ticket) > 0n ? "claim" : "exit";
}

/** The program's error codes, in declaration order from PaddockError (lib.rs). */
export const PADDOCK_ERROR_NAMES: Record<number, string> = {
  6000: "StalePrice", 6001: "UntrustedFeed", 6002: "BadMint", 6003: "NotOwner",
  6004: "InsufficientBalance", 6005: "MathOverflow", 6006: "WrongPhase", 6007: "BadCarIndex",
  6008: "NoSuchResult", 6009: "AlreadyClaimed", 6010: "ValidatorMismatch",
};

/** Name the PaddockError behind a failed send, or null if the failure wasn't one of ours.
 *  Sends go out with skipPreflight and confirm by status poll, so the code arrives as text
 *  in the error message rather than as a structured anchor error. */
export function paddockErrorName(e: unknown): string | null {
  const m = /custom program error: 0x([0-9a-f]+)|Custom":\s*(\d+)/i.exec(String((e as Error)?.message ?? e));
  if (!m) return null;
  const code = m[1] ? parseInt(m[1], 16) : Number(m[2]);
  return PADDOCK_ERROR_NAMES[code] ?? null;
}

/** A bet that arrived after the crank locked the market — normal play, not a fault. */
export class MarketClosedError extends Error {
  readonly code = "market_closed" as const;
  constructor(message: string) { super(message); this.name = "MarketClosedError"; }
}

/** A bet larger than the play balance sitting in the Bettor account. */
export class InsufficientBalanceError extends Error {
  readonly code = "insufficient_balance" as const;
  constructor(message: string) { super(message); this.name = "InsufficientBalanceError"; }
}

/** Onboarding can't proceed: the Bettor/Ticket pair is half-delegated, so `delegate_bettor`
 *  would try to re-delegate the live half. Only an `exit_bettor` can reunite them. */
export class BettorTornError extends Error {
  readonly code = "bettor_torn" as const;
  constructor(message: string) { super(message); this.name = "BettorTornError"; }
}

/** Cash-out refused: this ticket's stakes are riding the race running RIGHT NOW, whose
 *  result does not exist yet. See the comment on cashOut for why this refuses instead of
 *  exiting anyway. */
export class LiveStakesError extends Error {
  readonly code = "live_stakes" as const;
  constructor(message: string) { super(message); this.name = "LiveStakesError"; }
}

/** The one-time onboarding path, step by step. `delegate` → `confirm` is the ~25×1s owner
 *  poll the spec calls out: the first bet is slow and every bet after is instant, so that
 *  wait has to read as progress, never as a frozen button. */
export type OnboardStep = "join" | "wrap" | "deposit" | "delegate" | "confirm" | "ready";

/** The exit path, step by step — same contract as OnboardStep and for the same reason.
 *  `exit` → `undelegate` is the round trip back: the ER transaction confirms at once, then
 *  the delegation program hands the pair back on L1 seconds later. A cash-out that reports
 *  nothing across that gap is the exact frozen-button failure OnboardStep exists to avoid. */
export type CashOutStep = "claim" | "exit" | "undelegate" | "withdraw" | "unwrap" | "done";

export interface PaddockBook {
  address: string;
  pdas: PaddockPdas;
  /** The live shared race, read from the ER. null before the book's Race exists. */
  raceSnapshot(): Promise<RaceSnap | null>;
  /** This player's ER balance + current ticket, or null if they haven't joined. */
  bettorSnapshot(): Promise<BettorSnap | null>;
  /** L1 owners of the co-delegated Bettor/Ticket pair — the only sound "can this wallet bet?"
   *  signal. The ER serves a copy of an undelegated account too, so an ER read proves nothing. */
  delegationState(): Promise<DelegateState>;
  /** The owner wallet's L1 spendables: native SOL (the thing a wSOL deposit wraps) and the
   *  owner ATA's token balance (what a non-wSOL mint would deposit). Same shape as
   *  chain-round's walletFunds so staging code reads identically across the two programs.
   *  On the wSOL book `stake` is normally 0 — `ensureBettor` wraps from native SOL — but a
   *  wrap that landed ahead of a failed deposit leaves the shortfall sitting in the ATA, so a
   *  funding decision that reads only `sol` will tell that player to top up money they
   *  already have. */
  walletFunds(): Promise<{ sol: bigint; stake: bigint }>;
  /** The L1 Bettor ledger balance (0n when the account does not exist). Reads the L1 copy —
   *  the one `deposit` writes — so the staging gate can see money a failed delegation left
   *  behind instead of demanding fresh SOL for a seat that is already funded. Only meaningful
   *  while undelegated: anchor's owner check throws on a delegated pair (callers are on the
   *  fresh/busy path, where the pair is home). */
  bettorL1Balance(): Promise<bigint>;
  /** One-time onboarding: join → deposit → delegate_bettor on L1, each step skipped if it is
   *  already done, reporting every step it actually runs through `onStep`. */
  ensureBettor(amount: number | bigint, onStep?: (step: OnboardStep) => void): Promise<void>;
  placeBet(carId: number, amount: number | bigint): Promise<void>;
  claim(): Promise<void>;
  /** The whole way out: exit_bettor (ER → L1) → withdraw → unwrap, each step skipped if it
   *  is already done, reporting through `onStep`. Returns the base-unit amount the vault
   *  actually paid back. Throws LiveStakesError if the ticket is riding the live race. */
  cashOut(onStep?: (step: CashOutStep) => void): Promise<bigint>;
}

export function createPaddockBook(deps: { wallet: AnchorWalletLike; mint: PublicKey }): PaddockBook {
  const { wallet, mint } = deps;
  const owner = wallet.publicKey;
  const baseConn = new Connection(CHAIN.BASE_RPC, { commitment: "confirmed" });
  const erConn = new Connection(CHAIN.ER_RPC, { commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, wallet as anchor.Wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(new Connection(CHAIN.ER_RPC, { wsEndpoint: CHAIN.ER_WS, commitment: "confirmed" }), wallet as anchor.Wallet, { commitment: "confirmed" });
  const program = new anchor.Program<Paddock>(idlJson as Paddock, baseProvider);
  const programER = new anchor.Program<Paddock>(idlJson as Paddock, erProvider);
  const pdas = derivePaddockPdas(CHAIN.PADDOCK_PROGRAM_ID, owner, mint);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);

  // HTTP send + getSignatureStatuses poll — same reason as chain-round.ts:203: it dodges the
  // rpc-websockets v9 "Unknown action 'undefined'" bug on the ER signature stream.
  async function send(conn: Connection, builder: { transaction(): Promise<Transaction> }, cuLimit?: number, pollMs = 1000): Promise<string> {
    const tx = await builder.transaction();
    if (cuLimit) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    tx.feePayer = owner;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    const deadline = Date.now() + CONFIRM_BUDGET_MS;
    // Fast polls only while a healthy confirm could still land (the ER commits in well under
    // a second); past that window fall back to 1s so a dropped tx doesn't hammer a shared
    // anonymous endpoint for a minute — config.ts records real 429s on the public RPC from
    // exactly this kind of burst, with confirm polls named among the causes.
    const fastUntil = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
        return sig;
      }
      await sleep(Date.now() < fastUntil ? pollMs : 1000);
    }
    throw new Error(`tx ${sig} not confirmed within ${CONFIRM_BUDGET_MS / 1000}s`);
  }

  // Delegation and UNdelegation both land asynchronously: the tx confirms, then the
  // delegation program hands ownership over. Poll the pair's L1 owners — same shape and
  // cost as chain-round.ts:221, and the same function serves both directions (delegate
  // targets DELEGATION_PROGRAM, exit targets the paddock program).
  async function pollBettorOwner(target: PublicKey, label: string, tries: number, gapMs: number) {
    for (let i = 0; i < tries; i++) {
      const infos = await Promise.all([pdas.bettor, pdas.ticket].map((p) => baseConn.getAccountInfo(p)));
      if (infos.every((info) => info && info.owner.equals(target))) return;
      await sleep(gapMs);
    }
    throw new Error(`${label}: Bettor/Ticket did not reach owner ${target.toBase58()} in time`);
  }

  async function delegationState(): Promise<DelegateState> {
    const [bi, ti] = await Promise.all([
      baseConn.getAccountInfo(pdas.bettor),
      baseConn.getAccountInfo(pdas.ticket),
    ]);
    return classifyBettorDelegation({ bettor: bi?.owner ?? null, ticket: ti?.owner ?? null });
  }

  async function walletFunds(): Promise<{ sol: bigint; stake: bigint }> {
    const [sol, ata] = await Promise.all([
      baseConn.getBalance(owner),
      baseConn.getTokenAccountBalance(ownerAta).catch(() => null),
    ]);
    return { sol: BigInt(sol), stake: BigInt(ata?.value.amount ?? "0") };
  }

  async function bettorL1Balance(): Promise<bigint> {
    const acct = await program.account.bettor.fetchNullable(pdas.bettor);
    return acct ? big(acct.balance) : 0n;
  }

  async function raceSnapshot(): Promise<RaceSnap | null> {
    const r = await programER.account.race.fetchNullable(pdas.race);
    return r ? raceToSnap(r) : null;
  }

  async function bettorSnapshot(): Promise<BettorSnap | null> {
    const [b, t] = await Promise.all([
      programER.account.bettor.fetchNullable(pdas.bettor),
      programER.account.ticket.fetchNullable(pdas.ticket),
    ]);
    if (!b) return null;
    // Bettor and Ticket are created together by `join` and delegated together, so a
    // missing Ticket alongside a live Bettor is a torn account pair, not a real state —
    // report it as the empty ticket it would be rather than inventing stakes.
    const snap = t ? ticketToSnap(t) : { stakes: new Array<bigint>(GRID).fill(0n), raceSeq: null };
    return { balance: big(b.balance), ...snap };
  }

  async function claim(): Promise<void> {
    await send(erConn, programER.methods.claim().accountsPartial({
      payer: owner, mint, race: pdas.race, bettor: pdas.bettor, ticket: pdas.ticket,
    }));
  }

  return {
    address: owner.toBase58(),
    pdas,

    raceSnapshot,
    bettorSnapshot,
    delegationState,
    walletFunds,
    bettorL1Balance,
    claim,

    async ensureBettor(amount, onStep) {
      const step = (s: OnboardStep) => onStep?.(s);
      const state = await delegationState();
      if (state === "busy") {
        throw new BettorTornError("Your seat at the book is half-open — finish exiting, then try again.");
      }
      // Already delegated: `deposit` writes the L1 Bettor, and anchor's owner check rejects it
      // the moment the delegation program holds the account, so there is nothing left to run.
      // Topping a live bettor up is a different flow (exit → deposit → re-delegate), not this one.
      if (state === "reuse") { step("ready"); return; }

      // join — Bettor and Ticket are created by the same instruction, so either one missing
      // means the pair does not exist yet.
      const [bi, ti] = await Promise.all([
        baseConn.getAccountInfo(pdas.bettor),
        baseConn.getAccountInfo(pdas.ticket),
      ]);
      if (!bi || !ti) {
        step("join");
        await send(baseConn, program.methods.join().accountsPartial({
          payer: owner, mint, bettor: pdas.bettor, ticket: pdas.ticket, systemProgram: SystemProgram.programId,
        }));
      }

      // deposit — only the shortfall, so re-running after a half-finished onboarding tops up
      // instead of double-funding. Strictly before delegation, for the reason above.
      const want = BigInt(amount.toString());
      const acct = await program.account.bettor.fetchNullable(pdas.bettor);
      const have = acct ? big(acct.balance) : 0n;
      if (have < want) {
        const short = want - have;
        // wSOL is native-wrap (core/stake-currency.ts): the deposit's source ATA is fed by
        // wrapping native SOL, so the player only ever holds and spends SOL. Any other mint is
        // spl-transfer — its tokens must already be sitting in the owner's ATA.
        if (mint.equals(WSOL_MINT)) {
          const ata = wsolAta(owner);
          const info = await baseConn.getAccountInfo(ata);
          // Net what a stranded wrap already left in the ATA (a deposit that failed after its
          // wrap landed) — wrapping the full shortfall again would just strand it a second time.
          const ataBal = info ? BigInt((await baseConn.getTokenAccountBalance(ata)).value.amount) : 0n;
          const wrapLamports = short > ataBal ? short - ataBal : 0n;
          if (wrapLamports > 0n) {
            step("wrap");
            const ixs = buildWrapIxs({ owner, lamports: wrapLamports, ataExists: !!info });
            await send(baseConn, { async transaction() { return new Transaction().add(...ixs); } });
          }
        }
        step("deposit");
        await send(baseConn, program.methods.deposit(new BN(short.toString())).accountsPartial({
          owner, mint, bettor: pdas.bettor, ownerToken: ownerAta,
          vaultAuthority: pdas.vault, vaultToken: pdas.vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
        }));
      }

      // delegate_bettor — co-delegates Bettor AND Ticket, and MUST name the validator the book
      // pinned at init_book. Read it off the Book rather than assuming CHAIN.VALIDATOR: naming
      // a different one lands these accounts in another rollup from the Race, where they could
      // never be co-written, and the program rejects the mismatch with ValidatorMismatch (6010).
      const book = await program.account.book.fetchNullable(pdas.book);
      if (!book) throw new Error(`no paddock book for mint ${mint.toBase58()}`);
      step("delegate");
      await send(baseConn, program.methods.delegateBettor().accountsPartial({
        payer: owner, mint, book: pdas.book, bettor: pdas.bettor, ticket: pdas.ticket,
      }).remainingAccounts([{ pubkey: new PublicKey(book.validator), isSigner: false, isWritable: false }]), 400_000);
      step("confirm");
      await pollBettorOwner(CHAIN.DELEGATION_PROGRAM, "delegate_bettor", 25, 1000);
      step("ready");
    },

    async placeBet(carId, amount) {
      try {
        // 150ms, not the 1000ms default: the ER commits in well under a second, and a
        // second of dead button eats most of a market window's feel.
        await send(erConn, programER.methods.placeBet(carId, new BN(amount.toString())).accountsPartial({
          payer: owner, mint, race: pdas.race, bettor: pdas.bettor, ticket: pdas.ticket,
        }), undefined, 150);
      } catch (e) {
        const name = paddockErrorName(e);
        if (name === "WrongPhase") throw new MarketClosedError("Betting just closed for this race — the next market opens in about 46 seconds.");
        if (name === "InsufficientBalance") throw new InsufficientBalanceError("Not enough in your book balance for that bet.");
        throw e;
      }
    },

    // The exit is ensureBettor run backwards, ordering trap included. `deposit` writes the
    // L1 Bettor so it must run BEFORE the delegation; `withdraw` writes that SAME L1 Bettor,
    // so it must run AFTER the undelegation. While the delegation program owns the account
    // anchor's owner check rejects every L1 write, so exit_bettor is not a tidy-up that
    // happens to precede withdraw — it is the instruction that makes withdraw legal at all.
    async cashOut(onStep) {
      const step = (s: CashOutStep) => onStep?.(s);
      const state = await delegationState();

      // --- 1. exit_bettor — commit + undelegate the pair back to L1 (an ER instruction) ---
      // "busy" comes down this path deliberately: exit is the ONLY instruction that can
      // reunite a torn pair, and it is precisely what BettorTornError points the player at.
      if (state !== "fresh") {
        // classifyExit carries the whole rationale; this is the money-preserving half of the
        // exit and it reads the ER, because the delegated pair's live state lives there.
        const [race, mine] = await Promise.all([raceSnapshot(), bettorSnapshot()]);
        const action = race && mine ? classifyExit(race, mine) : "exit";
        if (action === "blocked") {
          throw new LiveStakesError("This race is still running — your stakes stay in the pool until it settles.");
        }
        if (action === "claim") {
          step("claim");
          await claim();
        }
        step("exit");
        await send(erConn, programER.methods.exitBettor().accountsPartial({
          payer: owner, mint, bettor: pdas.bettor, ticket: pdas.ticket,
        }));
        // Undelegation is asynchronous exactly like the delegation on the way in, and the ER
        // keeps serving a stale copy of an undelegated account (chain-round.ts:157) — so the
        // L1 owner is the only sound signal that the accounts came home.
        step("undelegate");
        await pollBettorOwner(CHAIN.PADDOCK_PROGRAM_ID, "exit_bettor", 40, 2000);
      }

      // --- 2. withdraw — vault ATA → the player's ATA, against the restored L1 balance ---
      const acct = await program.account.bettor.fetchNullable(pdas.bettor);
      const balance = acct ? big(acct.balance) : 0n;
      if (balance > 0n) {
        // withdraw's `owner_token` must already exist. Onboarding creates it while wrapping,
        // but a player who has cashed out before had it CLOSED by the unwrap below, so the
        // second cash-out has to put it back.
        const wd = program.methods.withdraw(new BN(balance.toString())).accountsPartial({
          owner, mint, bettor: pdas.bettor, ownerToken: ownerAta,
          vaultAuthority: pdas.vault, vaultToken: pdas.vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
        });
        const ata = await baseConn.getAccountInfo(ownerAta);
        step("withdraw");
        await send(baseConn, ata ? wd : wd.preInstructions([
          createAssociatedTokenAccountInstruction(owner, ownerAta, owner, mint),
        ]));
      }

      // --- 3. unwrap — wSOL is native-wrap (core/stake-currency.ts), so the money is only
      // really OUT once the ATA is closed and its lamports land in the player's own account.
      // The close returns the withdrawn amount AND the ATA's rent in one move. Any other mint
      // is spl-transfer: the tokens are already where they belong, sitting in the owner's ATA.
      if (mint.equals(WSOL_MINT)) {
        const ata = await baseConn.getAccountInfo(wsolAta(owner));
        if (ata) {
          step("unwrap");
          await send(baseConn, { async transaction() { return new Transaction().add(...buildUnwrapIxs({ owner })); } });
        }
      }
      step("done");
      return balance;
    },
  };
}
