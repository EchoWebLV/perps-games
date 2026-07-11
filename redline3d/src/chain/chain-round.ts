import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CHAIN, deriveFeedRegistry } from "./config";
import { wsolAta, buildWrapIxs, buildUnwrapIxs } from "./wsol";
import idlJson from "./idl/raider.json";
import type { Raider } from "./idl/raider";
import type { AnchorWalletLike } from "./anchor-wallet";

const { BN } = anchor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RaiderPdas { player: PublicKey; master: PublicKey; till: PublicKey; round: PublicKey; vaultAuthority: PublicKey; vaultToken: PublicKey; }

/** Derive the raider PDAs + the vault ATA for an owner+mint (matches lib.rs seeds).
 *  `master` = singleton bankroll `[house, mint]`; `till` = per-session `[house, mint, owner]`. */
export function deriveRaiderPdas(programId: PublicKey, owner: PublicKey, mint: PublicKey): RaiderPdas {
  const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], programId);
  // "house2": seed v2 — the legacy [b"house", wSOL] master pot is stuck delegated on devnet
  // (pre-upgrade session, no ix can undelegate a house account), so v2 re-homes the bankroll.
  const [master] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], programId);
  const [till] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer(), owner.toBuffer()], programId);
  const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], programId);
  const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
  return { player, master, till, round, vaultAuthority, vaultToken };
}

/** Mirror settle::max_payout — floor(stake × 23.75) (CAP_FP 25e6 × edge 0.95). The
 *  per-session slice carved off the master pot equals this for the player's bet. */
export function maxPayoutBase(stake: number): number {
  return Number((BigInt(stake) * 25_000_000n * 950_000n) / 1_000_000n / 1_000_000n);
}

/** On-chain Lazer raw mantissa + |expo| → human float (same scale as the client feed). */
export function rawToHuman(raw: number | bigint, expo: number): number {
  return Number(raw) * Math.pow(10, -Math.abs(expo));
}

export type AssetSym = "BTC" | "ETH" | "SOL";

export interface OpenedRound { entryRaw: bigint; entryExpo: number; entryHuman: number; entryTs?: number; deadlineTs: number; feed: string; }
export interface SettledRound { outcome: number; outcomeName: string; payout: bigint; exitRaw: bigint; exitHuman: number; balance: bigint; entryTs?: number; entryRaw?: bigint; deadlineTs: number; }
const OUTCOME = ["cashout", "cap", "liq", "time"];

/** A delegate attempt that can't proceed because the shared house is held (foreign or torn). */
export class DelegateBusyError extends Error {
  readonly code = "delegate_busy" as const;
  constructor(message: string) { super(message); this.name = "DelegateBusyError"; }
}

/** Session start rejected: the master pot can't cover this bet's slice (bankroll fully in play). */
export class BankrollFullError extends Error {
  readonly code = "bankroll_full" as const;
  constructor(message: string) { super(message); this.name = "BankrollFullError"; }
}

/** Session start rejected: the player's wallet can't fund the buy-in / fees (fresh Privy wallet). */
export class WalletUnfundedError extends Error {
  readonly code = "wallet_unfunded" as const;
  constructor(message: string) { super(message); this.name = "WalletUnfundedError"; }
}

export type DelegateState = "reuse" | "fresh" | "busy";

/**
 * Classify the three delegated raider PDAs' on-chain owners before delegating (player/till/round):
 *  - all delegated  → "reuse" (our own stale-but-live session; skip the delegate tx)
 *  - none delegated → "fresh" (normal delegate; nulls = not-yet-created PDAs count as not-delegated)
 *  - anything else  → "busy"  (torn mid-delegation only — the per-session till can never be foreign-held)
 */
export function classifyDelegateState(owners: {
  player: PublicKey | null; till: PublicKey | null; round: PublicKey | null;
}): DelegateState {
  const del = (o: PublicKey | null) => !!o && o.equals(CHAIN.DELEGATION_PROGRAM);
  const p = del(owners.player), t = del(owners.till), r = del(owners.round);
  if (p && t && r) return "reuse";
  if (!p && !t && !r) return "fresh";
  return "busy";
}

export interface RoundSnap {
  status: number; outcome: number; outcomeName: string;
  payout: bigint; banked: bigint; dir: number; lev: number;
  entryRaw: bigint; entryExpo: number; entryHuman: number; entryTs: number;
  exitRaw: bigint; exitHuman: number; deadlineTs: number;
}

export const HIGHWAY_DURATION_SENTINEL = -1;
export const HIGHWAY_CRANK_ITERATIONS = 24 * 60 * 60;

export function isHighwayRound(round: Pick<RoundSnap, "status" | "deadlineTs">): boolean {
  return round.status === 1 && round.deadlineTs < 0;
}

/** A round's stable on-chain identity: owner + deadline_ts. `deadline_ts` is written once at
 *  `open` and NEVER rewritten (flip/lever re-anchor `entry_raw`/`entry_expo`, so entry fields
 *  MUST NOT be part of the identity — keying on them made every post-flip settle look like a
 *  stale corpse and rounds never closed). Per-owner rounds are strictly serial (one Round PDA,
 *  each open gated on the prior settle + confirmed txs), so consecutive rounds can never share
 *  a deadline second in practice. */
export function roundKey(r: { deadlineTs: number }, owner: string): string {
  return `${owner}:${r.deadlineTs}`;
}

/** Result of a mid-round flip/lever: either re-anchored (still open) or settled (terminal-first hit). */
export type ActionResult =
  | { settled: false; banked: bigint; dir: number; lev: number; entryHuman: number }
  | ({ settled: true } & SettledRound);

/** Map an anchor-decoded Round account into a typed, BN-free snapshot. */
export function roundToSnap(r: {
  status: number; outcome: number; payout: { toString(): string }; banked: { toString(): string };
  dir: number; lev: number; entryRaw: { toString(): string }; entryExpo: number; entryTs?: number;
  exitRaw: { toString(): string }; deadlineTs: number;
}): RoundSnap {
  const entryExpo = Number(r.entryExpo);
  const entryRaw = BigInt(r.entryRaw.toString());
  const exitRaw = BigInt(r.exitRaw.toString());
  return {
    status: Number(r.status), outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?",
    payout: BigInt(r.payout.toString()), banked: BigInt(r.banked.toString()),
    dir: Number(r.dir), lev: Number(r.lev),
    entryRaw, entryExpo, entryHuman: rawToHuman(entryRaw, entryExpo), entryTs: Number(r.entryTs ?? 0),
    exitRaw, exitHuman: rawToHuman(exitRaw, entryExpo), deadlineTs: Number(r.deadlineTs),
  };
}

/** Shape a flip/lever outcome: settled payload when the action hit a terminal (status 2), else the re-anchored round. */
export function actionResultFromSnap(snap: RoundSnap, balance: bigint): ActionResult {
  if (snap.status === 2) {
    // deadlineTs is the settle's identity (owner + deadline_ts — see roundKey); entryTs/entryRaw
    // ride along as display/diagnostic fields (they re-anchor on flip/lever, so they must NOT key it).
    return { settled: true, outcome: snap.outcome, outcomeName: snap.outcomeName, payout: snap.payout, exitRaw: snap.exitRaw, exitHuman: snap.exitHuman, balance, entryTs: snap.entryTs, entryRaw: snap.entryRaw, deadlineTs: snap.deadlineTs };
  }
  return { settled: false, banked: snap.banked, dir: snap.dir, lev: snap.lev, entryHuman: snap.entryHuman };
}

export interface ChainRound {
  address: string;
  /** The owner WALLET's spendable funds: native SOL (fees/wrap) + the stake-token ATA balance. */
  walletFunds(): Promise<{ sol: bigint; stake: bigint }>;
  /** The master pot's UNLOCKED balance — how much bankroll a new session can still carve. */
  houseAvailable(): Promise<bigint>;
  /** This session's till UNLOCKED balance (ER copy when delegated) — the buffer left for the next round's lock. */
  tillAvailable(onEr?: boolean): Promise<bigint>;
  readPlayerBalance(onEr?: boolean): Promise<bigint>;
  readRoundStatus(onEr?: boolean): Promise<number>;
  readRound(onEr?: boolean): Promise<RoundSnap | null>;
  buyIn(amount: number): Promise<void>;
  ensureRoundInited(): Promise<void>;
  /** Classify the session PDAs' L1 owners — the ONLY sound "is a session live?" signal.
   *  (The ER keeps serving a stale copy of the Round after an undelegate, so an ER read
   *  is NOT a liveness check.) "reuse" = all delegated · "fresh" = none · "busy" = torn. */
  delegationState(): Promise<DelegateState>;
  delegate(): Promise<void>;
  sliceFromPot(slice: number): Promise<void>;
  sweepTill(): Promise<void>;
  // graceSecs (Skull "Death's Door" auto-liq grace, seconds), slFp/tpFp (Pink Rod
  // stop-loss / take-profit equity thresholds in SCALE units), refundFp (Flintstone
  // airbag — the liq refund fraction of stake, SCALE units, program-clamped ≤200_000)
  // are per-round risk knobs; 0 = off (the default for every car without that ability).
  open(asset: AssetSym, dir: 1 | -1, lev: number, stake: number, durationSecs: number, liqFp: number, graceSecs?: number, slFp?: number, tpFp?: number, refundFp?: number): Promise<OpenedRound>;
  close(): Promise<SettledRound>;
  flip(newDir: 1 | -1): Promise<ActionResult>;
  lever(newLev: number): Promise<ActionResult>;
  scheduleCrank(opts?: { intervalMs?: number; iterations?: number; taskId?: number }): Promise<void>;
  forceClose(): Promise<SettledRound>;
  commitAndUndelegate(): Promise<void>;
  withdraw(amount: number): Promise<void>;
  wrapForBuyIn(lamports: number): Promise<void>;
  unwrapAll(): Promise<void>;
}

export function createChainRound(deps: { wallet: AnchorWalletLike; mint: PublicKey }): ChainRound {
  const { wallet, mint } = deps;
  const owner = wallet.publicKey;
  const baseConn = new Connection(CHAIN.BASE_RPC, { commitment: "confirmed" });
  const erConn = new Connection(CHAIN.ER_RPC, { commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, wallet as anchor.Wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(new Connection(CHAIN.ER_RPC, { wsEndpoint: CHAIN.ER_WS, commitment: "confirmed" }), wallet as anchor.Wallet, { commitment: "confirmed" });
  const program = new anchor.Program<Raider>(idlJson as Raider, baseProvider);
  const programER = new anchor.Program<Raider>(idlJson as Raider, erProvider);
  const pdas = deriveRaiderPdas(CHAIN.PROGRAM_ID, owner, mint);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);
  const registry = deriveFeedRegistry(CHAIN.PROGRAM_ID);
  const feedFor = (asset: AssetSym) => CHAIN.FEEDS[asset];

  // The feed every settle path must pass — it must equal the feed `open` recorded on
  // the round (the program enforces `price_update.key() == round.feed`). Read it from
  // the live ER round; fall back to BTC only if the round isn't readable yet.
  async function roundFeed(): Promise<PublicKey> {
    const r = await programER.account.round.fetchNullable(pdas.round);
    return r ? new PublicKey(r.feed) : feedFor("BTC");
  }

  // HTTP send + getSignatureStatuses poll — dodges the rpc-websockets v9
  // "Unknown action 'undefined'" bug on the ER/Helius signature stream (helpers.ts:37).
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

  async function pollOwner(target: PublicKey, label: string, tries: number, gapMs: number) {
    for (let i = 0; i < tries; i++) {
      const infos = await Promise.all([pdas.player, pdas.till, pdas.round].map((p) => baseConn.getAccountInfo(p)));
      if (infos.every((info) => info && info.owner.equals(target))) return;
      await sleep(gapMs);
    }
    throw new Error(`${label}: PDAs did not reach owner ${target.toBase58()} in time`);
  }

  // L1 owners of the three session PDAs → reuse / fresh / busy. Shared by delegate()
  // (skip-or-throw hardening) and the public delegationState() liveness check.
  async function delegationState(): Promise<DelegateState> {
    const [pi, ti, ri] = await Promise.all([
      baseConn.getAccountInfo(pdas.player),
      baseConn.getAccountInfo(pdas.till),
      baseConn.getAccountInfo(pdas.round),
    ]);
    return classifyDelegateState({ player: pi?.owner ?? null, till: ti?.owner ?? null, round: ri?.owner ?? null });
  }

  return {
    address: owner.toBase58(),

    async walletFunds() {
      const [sol, stake] = await Promise.all([
        baseConn.getBalance(owner).then(BigInt),
        baseConn.getTokenAccountBalance(ownerAta).then((r) => BigInt(r.value.amount)).catch(() => 0n), // no ATA yet = 0
      ]);
      return { sol, stake };
    },

    async houseAvailable() {
      const m = await program.account.houseBalance.fetchNullable(pdas.master);
      if (!m) return 0n;
      return BigInt(m.balance.toString()) - BigInt(m.locked.toString());
    },

    async tillAvailable(onEr = false) {
      const prog = onEr ? programER : program;
      const t = await prog.account.houseBalance.fetchNullable(pdas.till);
      if (!t) return 0n;
      return BigInt(t.balance.toString()) - BigInt(t.locked.toString());
    },

    async readPlayerBalance(onEr = false) {
      const prog = onEr ? programER : program;
      const acct = await prog.account.playerBalance.fetchNullable(pdas.player);
      return acct ? BigInt(acct.balance.toString()) : 0n;
    },
    async readRoundStatus(onEr = false) {
      const prog = onEr ? programER : program;
      const acct = await prog.account.round.fetchNullable(pdas.round);
      return acct ? Number(acct.status) : 0;
    },

    async buyIn(amount) {
      await send(baseConn, program.methods.buyIn(new BN(amount)).accountsPartial({
        owner, mint, player: pdas.player, ownerToken: ownerAta, vaultAuthority: pdas.vaultAuthority, vaultToken: pdas.vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }));
    },

    async ensureRoundInited() {
      const existing = await program.account.round.fetchNullable(pdas.round);
      if (existing) return;
      await send(baseConn, program.methods.initRound().accountsPartial({ owner, round: pdas.round, systemProgram: SystemProgram.programId }));
    },

    delegationState,

    async delegate() {
      const state = await delegationState();
      if (state === "reuse") return;
      if (state === "busy") {
        throw new DelegateBusyError("You're still in a race — finish it, then try again.");
      }
      try {
        await send(baseConn, program.methods.delegateSession().accountsPartial({
          payer: owner, mint, player: pdas.player, house: pdas.till, round: pdas.round,
        }).remainingAccounts([{ pubkey: CHAIN.VALIDATOR, isSigner: false, isWritable: false }]), 400_000);
      } catch (e) {
        if (String((e as Error).message).includes("ExternalAccountDataModified")) {
          throw new DelegateBusyError("Still getting you on track — try again in a moment.");
        }
        throw e;
      }
      await pollOwner(CHAIN.DELEGATION_PROGRAM, "delegate", 25, 1000);
    },

    async sliceFromPot(slice) {
      // Pre-check the pot so the common "bankroll fully in play" case fails fast with a
      // typed error instead of a raw tx failure (a race where the last slice is taken
      // between this read and the send is caught below as a fallback).
      const master = await program.account.houseBalance.fetchNullable(pdas.master);
      if (!master || BigInt(master.balance.toString()) < BigInt(slice)) {
        throw new BankrollFullError("Tables are full right now — try again in a moment.");
      }
      try {
        await send(baseConn, program.methods.sliceFromPot(new BN(slice)).accountsPartial({
          owner, mint, master: pdas.master, till: pdas.till, systemProgram: SystemProgram.programId,
        }));
      } catch (e) {
        if (String((e as Error).message).includes("HouseUndercapitalized")) {
          throw new BankrollFullError("Tables are full right now — try again in a moment.");
        }
        throw e;
      }
    },

    async sweepTill() {
      await send(baseConn, program.methods.sweepTill().accountsPartial({
        payer: owner, mint, owner, master: pdas.master, till: pdas.till,
      }));
    },

    async open(asset, dir, lev, stake, durationSecs, liqFp, graceSecs = 0, slFp = 0, tpFp = 0, refundFp = 0) {
      await send(erConn, programER.methods.open(CHAIN.ASSET_ID[asset], dir, lev, new BN(stake), new BN(durationSecs), liqFp, graceSecs, slFp, tpFp, refundFp).accountsPartial({
        player: pdas.player, house: pdas.till, round: pdas.round, mint, priceUpdate: feedFor(asset), registry, playerAuthority: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      return { entryRaw: BigInt(r.entryRaw.toString()), entryExpo: Number(r.entryExpo), entryHuman: rawToHuman(BigInt(r.entryRaw.toString()), Number(r.entryExpo)), entryTs: Number(r.entryTs), deadlineTs: Number(r.deadlineTs), feed: r.feed.toBase58() };
    },

    async close() {
      await send(erConn, programER.methods.close().accountsPartial({
        player: pdas.player, house: pdas.till, round: pdas.round, mint, priceUpdate: await roundFeed(), playerAuthority: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      const p = await programER.account.playerBalance.fetch(pdas.player);
      return { outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?", payout: BigInt(r.payout.toString()), exitRaw: BigInt(r.exitRaw.toString()), exitHuman: rawToHuman(BigInt(r.exitRaw.toString()), Number(r.entryExpo)), balance: BigInt(p.balance.toString()), entryTs: Number(r.entryTs), entryRaw: BigInt(r.entryRaw.toString()), deadlineTs: Number(r.deadlineTs) };
    },

    async forceClose() {
      await send(erConn, programER.methods.forceClose().accountsPartial({
        player: pdas.player, house: pdas.till, round: pdas.round, mint, priceUpdate: await roundFeed(), caller: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      const p = await programER.account.playerBalance.fetch(pdas.player);
      return { outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?", payout: BigInt(r.payout.toString()), exitRaw: BigInt(r.exitRaw.toString()), exitHuman: rawToHuman(BigInt(r.exitRaw.toString()), Number(r.entryExpo)), balance: BigInt(p.balance.toString()), entryTs: Number(r.entryTs), entryRaw: BigInt(r.entryRaw.toString()), deadlineTs: Number(r.deadlineTs) };
    },

    async readRound(onEr = false) {
      const prog = onEr ? programER : program;
      const acct = await prog.account.round.fetchNullable(pdas.round);
      return acct ? roundToSnap(acct) : null;
    },

    async flip(newDir) {
      await send(erConn, programER.methods.flip(newDir).accountsPartial({
        player: pdas.player, house: pdas.till, round: pdas.round, mint, priceUpdate: await roundFeed(), playerAuthority: owner,
      }));
      const snap = roundToSnap(await programER.account.round.fetch(pdas.round));
      const balance = snap.status === 2 ? BigInt((await programER.account.playerBalance.fetch(pdas.player)).balance.toString()) : 0n;
      return actionResultFromSnap(snap, balance);
    },

    async lever(newLev) {
      await send(erConn, programER.methods.lever(newLev).accountsPartial({
        player: pdas.player, house: pdas.till, round: pdas.round, mint, priceUpdate: await roundFeed(), playerAuthority: owner,
      }));
      const snap = roundToSnap(await programER.account.round.fetch(pdas.round));
      const balance = snap.status === 2 ? BigInt((await programER.account.playerBalance.fetch(pdas.player)).balance.toString()) : 0n;
      return actionResultFromSnap(snap, balance);
    },

    async scheduleCrank(opts = {}) {
      const intervalMs = opts.intervalMs ?? 1000;
      const iterations = opts.iterations ?? 70; // ~70s coverage over the 60s round cap
      const taskId = opts.taskId ?? Date.now(); // unique per round within a session
      await send(erConn, programER.methods.scheduleTick(new BN(taskId), new BN(intervalMs), new BN(iterations)).accountsPartial({
        magicProgram: CHAIN.MAGIC_PROGRAM, payer: owner, player: pdas.player, house: pdas.till, round: pdas.round, mint, priceUpdate: await roundFeed(),
      }));
    },

    async commitAndUndelegate() {
      await send(erConn, programER.methods.commitAndUndelegate().accountsPartial({
        payer: owner, player: pdas.player, house: pdas.till, round: pdas.round, mint,
      }));
      await pollOwner(CHAIN.PROGRAM_ID, "undelegate", 40, 2000);
    },

    async withdraw(amount) {
      await send(baseConn, program.methods.withdraw(new BN(amount)).accountsPartial({
        owner, mint, player: pdas.player, vaultAuthority: pdas.vaultAuthority, vaultToken: pdas.vaultToken, ownerToken: ownerAta, tokenProgram: TOKEN_PROGRAM_ID,
      }));
    },

    // --- wSOL: the stake mint is wrapped SOL, so the client wraps native SOL into the
    // owner's wSOL ATA before buy_in and unwraps (closes the ATA) on withdraw. Invisible
    // to the player — they hold/spend/receive native SOL. (See wsol.ts.)
    async wrapForBuyIn(lamports) {
      const ata = wsolAta(owner);
      const info = await baseConn.getAccountInfo(ata);
      const ixs = buildWrapIxs({ owner, lamports: BigInt(lamports), ataExists: !!info });
      await send(baseConn, { async transaction() { return new Transaction().add(...ixs); } });
    },

    async unwrapAll() {
      const ata = wsolAta(owner);
      const info = await baseConn.getAccountInfo(ata);
      if (!info) return; // nothing wrapped
      const ixs = buildUnwrapIxs({ owner });
      await send(baseConn, { async transaction() { return new Transaction().add(...ixs); } });
    },
  };
}
