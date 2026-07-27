// paddock.ts — client for the pari-mutuel race book. Same shape as chain-round.ts:
// PDA derivation, BN-free snapshots, HTTP-poll sends. Betting lives entirely in the ER
// (Race is delegated permanently; Bettor/Ticket per player), so place_bet/claim target
// CHAIN.ER_RPC, while the one-time onboarding (join / deposit / delegate_bettor) is L1.
// The L1 exit side (exit_bettor / withdraw) is not wired yet.
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CHAIN } from "./config";
import { WSOL_MINT, wsolAta, buildWrapIxs } from "./wsol";
import idlJson from "./idl/paddock.json";
import type { Paddock } from "./idl/paddock";
import type { AnchorWalletLike } from "./anchor-wallet";
import type { DelegateState } from "./chain-round";

const { BN } = anchor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** The one-time onboarding path, step by step. `delegate` → `confirm` is the ~25×1s owner
 *  poll the spec calls out: the first bet is slow and every bet after is instant, so that
 *  wait has to read as progress, never as a frozen button. */
export type OnboardStep = "join" | "wrap" | "deposit" | "delegate" | "confirm" | "ready";

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
  /** One-time onboarding: join → deposit → delegate_bettor on L1, each step skipped if it is
   *  already done, reporting every step it actually runs through `onStep`. */
  ensureBettor(amount: number | bigint, onStep?: (step: OnboardStep) => void): Promise<void>;
  placeBet(carId: number, amount: number | bigint): Promise<void>;
  claim(): Promise<void>;
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
  async function send(conn: Connection, builder: { transaction(): Promise<Transaction> }, cuLimit?: number): Promise<string> {
    const tx = await builder.transaction();
    if (cuLimit) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    tx.feePayer = owner;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    for (let i = 0; i < 60; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
        return sig;
      }
      await sleep(1000);
    }
    throw new Error(`tx ${sig} not confirmed within 60s`);
  }

  // The delegation CPI lands asynchronously: the tx confirms, then the delegation program
  // takes ownership. Poll the pair's L1 owners — same shape and cost as chain-round.ts:221.
  async function pollBettorOwner(target: PublicKey, tries: number, gapMs: number) {
    for (let i = 0; i < tries; i++) {
      const infos = await Promise.all([pdas.bettor, pdas.ticket].map((p) => baseConn.getAccountInfo(p)));
      if (infos.every((info) => info && info.owner.equals(target))) return;
      await sleep(gapMs);
    }
    throw new Error(`delegate_bettor: Bettor/Ticket did not reach owner ${target.toBase58()} in time`);
  }

  async function delegationState(): Promise<DelegateState> {
    const [bi, ti] = await Promise.all([
      baseConn.getAccountInfo(pdas.bettor),
      baseConn.getAccountInfo(pdas.ticket),
    ]);
    return classifyBettorDelegation({ bettor: bi?.owner ?? null, ticket: ti?.owner ?? null });
  }

  return {
    address: owner.toBase58(),
    pdas,

    async raceSnapshot() {
      const r = await programER.account.race.fetchNullable(pdas.race);
      return r ? raceToSnap(r) : null;
    },

    async bettorSnapshot() {
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
    },

    delegationState,

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
          step("wrap");
          const ata = wsolAta(owner);
          const info = await baseConn.getAccountInfo(ata);
          const ixs = buildWrapIxs({ owner, lamports: short, ataExists: !!info });
          await send(baseConn, { async transaction() { return new Transaction().add(...ixs); } });
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
      await pollBettorOwner(CHAIN.DELEGATION_PROGRAM, 25, 1000);
      step("ready");
    },

    async placeBet(carId, amount) {
      try {
        await send(erConn, programER.methods.placeBet(carId, new BN(amount.toString())).accountsPartial({
          payer: owner, mint, race: pdas.race, bettor: pdas.bettor, ticket: pdas.ticket,
        }));
      } catch (e) {
        const name = paddockErrorName(e);
        if (name === "WrongPhase") throw new MarketClosedError("Betting just closed for this race — the next one is seconds away.");
        if (name === "InsufficientBalance") throw new InsufficientBalanceError("Not enough in your book balance for that bet.");
        throw e;
      }
    },

    async claim() {
      await send(erConn, programER.methods.claim().accountsPartial({
        payer: owner, mint, race: pdas.race, bettor: pdas.bettor, ticket: pdas.ticket,
      }));
    },
  };
}
