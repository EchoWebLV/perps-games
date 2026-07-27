// paddock.ts — client for the pari-mutuel race book. Same shape as chain-round.ts:
// PDA derivation, BN-free snapshots, HTTP-poll sends. The book lives entirely in the ER
// (Race is delegated permanently; Bettor/Ticket per player), so every call here targets
// CHAIN.ER_RPC. The L1 side (join / deposit / delegate / withdraw) is not wired yet.
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { CHAIN } from "./config";
import idlJson from "./idl/paddock.json";
import type { Paddock } from "./idl/paddock";
import type { AnchorWalletLike } from "./anchor-wallet";

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

export interface PaddockPdas { book: PublicKey; race: PublicKey; vault: PublicKey; bettor: PublicKey; ticket: PublicKey; }

/** Derive the paddock PDAs for an owner+mint (matches state.rs seeds).
 *  `book`/`race`/`vault` are singletons per mint; `bettor`/`ticket` are per player.
 *  `vault` is the vault AUTHORITY PDA — the vault's token account is its ATA. */
export function derivePaddockPdas(programId: PublicKey, owner: PublicKey, mint: PublicKey): PaddockPdas {
  const [book] = PublicKey.findProgramAddressSync([Buffer.from("book"), mint.toBuffer()], programId);
  const [race] = PublicKey.findProgramAddressSync([Buffer.from("race"), mint.toBuffer()], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], programId);
  const [bettor] = PublicKey.findProgramAddressSync([Buffer.from("bettor"), owner.toBuffer(), mint.toBuffer()], programId);
  const [ticket] = PublicKey.findProgramAddressSync([Buffer.from("ticket"), owner.toBuffer(), mint.toBuffer()], programId);
  return { book, race, vault, bettor, ticket };
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

export interface PaddockBook {
  address: string;
  pdas: PaddockPdas;
  /** The live shared race, read from the ER. null before the book's Race exists. */
  raceSnapshot(): Promise<RaceSnap | null>;
  /** This player's ER balance + current ticket, or null if they haven't joined. */
  bettorSnapshot(): Promise<BettorSnap | null>;
  placeBet(carId: number, amount: number | bigint): Promise<void>;
  claim(): Promise<void>;
}

export function createPaddockBook(deps: { wallet: AnchorWalletLike; mint: PublicKey }): PaddockBook {
  const { wallet, mint } = deps;
  const owner = wallet.publicKey;
  const erConn = new Connection(CHAIN.ER_RPC, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(new Connection(CHAIN.ER_RPC, { wsEndpoint: CHAIN.ER_WS, commitment: "confirmed" }), wallet as anchor.Wallet, { commitment: "confirmed" });
  const programER = new anchor.Program<Paddock>(idlJson as Paddock, erProvider);
  const pdas = derivePaddockPdas(CHAIN.PADDOCK_PROGRAM_ID, owner, mint);

  // HTTP send + getSignatureStatuses poll — same reason as chain-round.ts:203: it dodges the
  // rpc-websockets v9 "Unknown action 'undefined'" bug on the ER signature stream.
  async function send(builder: { transaction(): Promise<Transaction> }, cuLimit?: number): Promise<string> {
    const tx = await builder.transaction();
    if (cuLimit) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    tx.feePayer = owner;
    tx.recentBlockhash = (await erConn.getLatestBlockhash("confirmed")).blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    for (let i = 0; i < 60; i++) {
      const st = (await erConn.getSignatureStatuses([sig])).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
        return sig;
      }
      await sleep(1000);
    }
    throw new Error(`tx ${sig} not confirmed within 60s`);
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

    async placeBet(carId, amount) {
      try {
        await send(programER.methods.placeBet(carId, new BN(amount.toString())).accountsPartial({
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
      await send(programER.methods.claim().accountsPartial({
        payer: owner, mint, race: pdas.race, bettor: pdas.bettor, ticket: pdas.ticket,
      }));
    },
  };
}
