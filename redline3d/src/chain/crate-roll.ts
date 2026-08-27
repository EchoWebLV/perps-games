// crate-roll.ts — client for the crate_roll VRF consumer program: send request_roll with the
// session wallet, then poll the RollSlot PDA until MagicBlock's oracle fulfills OUR nonce.
// Pure orchestration is factored behind CrateRollIo so the poll/nonce/timeout logic is unit-testable;
// makeCrateRollIo binds the real anchor program (mirrors chain-round.ts's provider pattern).
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { CHAIN } from "./config";
import type { AnchorWalletLike } from "./anchor-wallet";
import { bytesToDraws } from "../core/vrf-draws";
import idl from "./idl/crate-roll.json";

export interface RollSlotState { nonce: number; fulfilled: boolean; randomness: Uint8Array; }
export interface CrateRollIo {
  /** current on-chain slot state, or null if the PDA doesn't exist yet */
  fetchSlot(): Promise<RollSlotState | null>;
  /** send + confirm the request_roll tx (signed by the session wallet) */
  request(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One VRF request; returns the fulfilled 32-byte randomness. */
export function requestCrateRandomness(io: CrateRollIo, opts: { timeoutMs?: number; pollMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000, pollMs = opts.pollMs ?? 500;
  const now = io.now ?? Date.now;
  return async (): Promise<Uint8Array> => {
    const before = await io.fetchSlot();
    const expect = (before?.nonce ?? 0) + 1;
    await io.request();
    const t0 = now();
    for (;;) {
      const s = await io.fetchSlot();
      if (s && s.fulfilled && s.nonce === expect) return s.randomness;
      if (now() - t0 > timeoutMs) throw new Error("vrf_timeout");
      await io.sleep(pollMs);
    }
  };
}

/** Returns a draws(n) function: one VRF request per call, resolved to n uniform [0,1) draws. */
export function createCrateRollDraws(io: CrateRollIo, opts: { timeoutMs?: number; pollMs?: number } = {}) {
  const roll = requestCrateRandomness(io, opts);
  return async (n: number): Promise<number[]> => bytesToDraws(await roll(), n);
}

/** VRF request that also returns the raw bytes (for the server-verified open). */
export function createCrateRoll(io: CrateRollIo, opts: { timeoutMs?: number; pollMs?: number } = {}) {
  const roll = requestCrateRandomness(io, opts);
  return async (n: number): Promise<{ draws: number[]; bytesHex: string }> => {
    const bytes = await roll();
    return { draws: bytesToDraws(bytes, n), bytesHex: bytesToHex(bytes) };
  };
}

/** Real io against devnet via the session's anchor wallet. */
export function makeCrateRollIo(wallet: AnchorWalletLike): CrateRollIo {
  const conn = new Connection(CHAIN.BASE_RPC, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(conn, wallet as anchor.Wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const [rollSlot] = PublicKey.findProgramAddressSync([Buffer.from("roll"), wallet.publicKey.toBuffer()], CHAIN.CRATE_ROLL_PROGRAM_ID);
  return {
    async fetchSlot() {
      const s: any = await (program.account as any).rollSlot.fetchNullable(rollSlot);
      return s ? { nonce: Number(s.nonce), fulfilled: !!s.fulfilled, randomness: new Uint8Array(s.randomness) } : null;
    },
    async request() {
      await (program.methods as any).requestRoll().accounts({ payer: wallet.publicKey }).rpc();
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
