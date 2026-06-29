import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CHAIN } from "./config";
import idlJson from "./idl/raider.json";
import type { Raider } from "./idl/raider";
import type { AnchorWalletLike } from "./anchor-wallet";

const { BN } = anchor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RaiderPdas { player: PublicKey; house: PublicKey; round: PublicKey; vaultAuthority: PublicKey; vaultToken: PublicKey; }

/** Derive the four raider PDAs + the vault ATA for an owner+mint (matches lib.rs seeds). */
export function deriveRaiderPdas(programId: PublicKey, owner: PublicKey, mint: PublicKey): RaiderPdas {
  const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], programId);
  const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], programId);
  const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], programId);
  const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
  return { player, house, round, vaultAuthority, vaultToken };
}

/** On-chain Lazer raw mantissa + |expo| → human float (same scale as the client feed). */
export function rawToHuman(raw: number | bigint, expo: number): number {
  return Number(raw) * Math.pow(10, -Math.abs(expo));
}

export interface OpenedRound { entryRaw: bigint; entryExpo: number; entryHuman: number; deadlineTs: number; }
export interface SettledRound { outcome: number; outcomeName: string; payout: bigint; exitRaw: bigint; exitHuman: number; balance: bigint; }
const OUTCOME = ["cashout", "cap", "liq", "time"];

export interface RoundSnap {
  status: number; outcome: number; outcomeName: string;
  payout: bigint; banked: bigint; dir: number; lev: number;
  entryRaw: bigint; entryExpo: number; entryHuman: number;
  exitRaw: bigint; exitHuman: number; deadlineTs: number;
}

/** Result of a mid-round flip/lever: either re-anchored (still open) or settled (terminal-first hit). */
export type ActionResult =
  | { settled: false; banked: bigint; dir: number; lev: number; entryHuman: number }
  | ({ settled: true } & SettledRound);

/** Map an anchor-decoded Round account into a typed, BN-free snapshot. */
export function roundToSnap(r: {
  status: number; outcome: number; payout: { toString(): string }; banked: { toString(): string };
  dir: number; lev: number; entryRaw: { toString(): string }; entryExpo: number;
  exitRaw: { toString(): string }; deadlineTs: number;
}): RoundSnap {
  const entryExpo = Number(r.entryExpo);
  const entryRaw = BigInt(r.entryRaw.toString());
  const exitRaw = BigInt(r.exitRaw.toString());
  return {
    status: Number(r.status), outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?",
    payout: BigInt(r.payout.toString()), banked: BigInt(r.banked.toString()),
    dir: Number(r.dir), lev: Number(r.lev),
    entryRaw, entryExpo, entryHuman: rawToHuman(entryRaw, entryExpo),
    exitRaw, exitHuman: rawToHuman(exitRaw, entryExpo), deadlineTs: Number(r.deadlineTs),
  };
}

/** Shape a flip/lever outcome: settled payload when the action hit a terminal (status 2), else the re-anchored round. */
export function actionResultFromSnap(snap: RoundSnap, balance: bigint): ActionResult {
  if (snap.status === 2) {
    return { settled: true, outcome: snap.outcome, outcomeName: snap.outcomeName, payout: snap.payout, exitRaw: snap.exitRaw, exitHuman: snap.exitHuman, balance };
  }
  return { settled: false, banked: snap.banked, dir: snap.dir, lev: snap.lev, entryHuman: snap.entryHuman };
}

export interface ChainRound {
  address: string;
  readPlayerBalance(onEr?: boolean): Promise<bigint>;
  readRoundStatus(onEr?: boolean): Promise<number>;
  buyIn(amount: number): Promise<void>;
  ensureRoundInited(): Promise<void>;
  delegate(): Promise<void>;
  open(dir: 1 | -1, lev: number, stake: number): Promise<OpenedRound>;
  close(): Promise<SettledRound>;
  forceClose(): Promise<SettledRound>;
  commitAndUndelegate(): Promise<void>;
  withdraw(amount: number): Promise<void>;
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
      const infos = await Promise.all([pdas.player, pdas.house, pdas.round].map((p) => baseConn.getAccountInfo(p)));
      if (infos.every((info) => info && info.owner.equals(target))) return;
      await sleep(gapMs);
    }
    throw new Error(`${label}: PDAs did not reach owner ${target.toBase58()} in time`);
  }

  return {
    address: owner.toBase58(),

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

    async delegate() {
      await send(baseConn, program.methods.delegateSession().accountsPartial({
        payer: owner, mint, player: pdas.player, house: pdas.house, round: pdas.round,
      }).remainingAccounts([{ pubkey: CHAIN.VALIDATOR, isSigner: false, isWritable: false }]), 400_000);
      await pollOwner(CHAIN.DELEGATION_PROGRAM, "delegate", 25, 1000);
    },

    async open(dir, lev, stake) {
      await send(erConn, programER.methods.open(dir, lev, new BN(stake)).accountsPartial({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, playerAuthority: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      return { entryRaw: BigInt(r.entryRaw.toString()), entryExpo: Number(r.entryExpo), entryHuman: rawToHuman(BigInt(r.entryRaw.toString()), Number(r.entryExpo)), deadlineTs: Number(r.deadlineTs) };
    },

    async close() {
      await send(erConn, programER.methods.close().accountsPartial({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, playerAuthority: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      const p = await programER.account.playerBalance.fetch(pdas.player);
      return { outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?", payout: BigInt(r.payout.toString()), exitRaw: BigInt(r.exitRaw.toString()), exitHuman: rawToHuman(BigInt(r.exitRaw.toString()), Number(r.entryExpo)), balance: BigInt(p.balance.toString()) };
    },

    async forceClose() {
      await send(erConn, programER.methods.forceClose().accountsPartial({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, caller: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      const p = await programER.account.playerBalance.fetch(pdas.player);
      return { outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?", payout: BigInt(r.payout.toString()), exitRaw: BigInt(r.exitRaw.toString()), exitHuman: rawToHuman(BigInt(r.exitRaw.toString()), Number(r.entryExpo)), balance: BigInt(p.balance.toString()) };
    },

    async commitAndUndelegate() {
      await send(erConn, programER.methods.commitAndUndelegate().accountsPartial({
        payer: owner, player: pdas.player, house: pdas.house, round: pdas.round, mint,
      }));
      await pollOwner(CHAIN.PROGRAM_ID, "undelegate", 40, 2000);
    },

    async withdraw(amount) {
      await send(baseConn, program.methods.withdraw(new BN(amount)).accountsPartial({
        owner, mint, player: pdas.player, vaultAuthority: pdas.vaultAuthority, vaultToken: pdas.vaultToken, ownerToken: ownerAta, tokenProgram: TOKEN_PROGRAM_ID,
      }));
    },
  };
}
