import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import type { PresenceHighway, PresencePlayer } from "../core/presence";
import { CHAIN } from "./config";
import idlJson from "./idl/raider.json";

export interface HighwayRoundRecord {
  owner: string;
  feed: string;
  status: number;
  deadlineTs: number;
  dir: number;
  lev: number;
}

export type HighwayRoundReader = (roundPda: string) => Promise<HighwayRoundRecord | null>;

export function selectRemoteHighwayPlayers(
  players: PresencePlayer[],
  ownWallet: string,
  asset: PresenceHighway["asset"],
): PresencePlayer[] {
  return players.filter((player) =>
    player.highway?.asset === asset && player.highway.wallet !== ownWallet,
  );
}

export function deriveHighwayRoundPda(wallet: string): string | null {
  try {
    const owner = new PublicKey(wallet);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("round"), owner.toBuffer()],
      CHAIN.PROGRAM_ID,
    )[0].toBase58();
  } catch {
    return null;
  }
}

export async function verifyHighwayPresence(
  advertised: PresenceHighway,
  readRound: HighwayRoundReader,
): Promise<PresenceHighway | null> {
  const expectedRound = deriveHighwayRoundPda(advertised.wallet);
  if (expectedRound === null || expectedRound !== advertised.roundPda) return null;

  let round: HighwayRoundRecord | null;
  try {
    round = await readRound(advertised.roundPda);
  } catch {
    return null;
  }
  if (round === null) return null;
  if (round.owner !== advertised.wallet) return null;
  if (round.feed !== CHAIN.FEEDS[advertised.asset].toBase58()) return null;
  if (round.status !== 1 || round.deadlineTs >= 0) return null;
  if (round.dir !== advertised.dir || round.lev !== advertised.lev) return null;
  return advertised;
}

export function createHighwayRoundReader(
  connection = new Connection(CHAIN.ER_RPC, { commitment: "confirmed" }),
): HighwayRoundReader {
  const coder = new BorshAccountsCoder(idlJson as unknown as Idl);
  return async (roundPda) => {
    let key: PublicKey;
    try { key = new PublicKey(roundPda); } catch { return null; }
    const account = await connection.getAccountInfo(key, "confirmed");
    if (!account || !account.owner.equals(CHAIN.PROGRAM_ID)) return null;
    const decoded = coder.decode("Round", account.data) as Record<string, unknown> | null;
    if (!decoded) return null;
    const owner = decoded.owner as PublicKey | undefined;
    const feed = decoded.feed as PublicKey | undefined;
    const deadline = decoded.deadline_ts ?? decoded.deadlineTs;
    if (!owner || !feed || deadline === undefined) return null;
    return {
      owner: owner.toBase58(),
      feed: feed.toBase58(),
      status: Number(decoded.status),
      deadlineTs: Number(deadline),
      dir: Number(decoded.dir),
      lev: Number(decoded.lev),
    };
  };
}
