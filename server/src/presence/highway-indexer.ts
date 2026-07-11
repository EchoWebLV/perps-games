import bs58 from "bs58";
import type { PresenceHighway } from "./protocol.js";

const ROUND_DISCRIMINATOR = Uint8Array.from([87, 127, 165, 51, 73, 78, 116, 174]);
const ROUND_ACCOUNT_SIZE = 190;

const ASSET_BY_FEED = new Map<string, PresenceHighway["asset"]>([
  ["71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr", "BTC"],
  ["5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG", "ETH"],
  ["ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu", "SOL"],
]);

export const HIGHWAY_PROGRAM_ID = "FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv";
export const DEFAULT_HIGHWAY_RPC = "https://devnet.magicblock.app";

export interface HighwayRoundRecord {
  roundPda: string;
  owner: string;
  feed: string;
  status: number;
  deadlineTs: number;
  dir: number;
  lev: number;
}

export type HighwayRoundListReader = () => Promise<HighwayRoundRecord[]>;

export interface HighwayIndexer {
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

function laneSeed(roundPda: string): number {
  let hash = 0;
  for (let i = 0; i < roundPda.length; i++) hash = (hash * 31 + roundPda.charCodeAt(i)) >>> 0;
  return hash % 3;
}

function toPresence(record: HighwayRoundRecord): PresenceHighway | null {
  const asset = ASSET_BY_FEED.get(record.feed);
  if (!asset || record.status !== 1 || record.deadlineTs >= 0) return null;
  if (record.dir !== 1 && record.dir !== -1) return null;
  if (!Number.isInteger(record.lev) || record.lev < 10 || record.lev > 250 || record.lev % 10 !== 0) {
    return null;
  }
  return {
    wallet: record.owner,
    asset,
    roundPda: record.roundPda,
    dir: record.dir,
    lev: record.lev,
    laneSeed: laneSeed(record.roundPda),
    carId: "Highway",
  };
}

export function makeHighwayIndexer(options: {
  read: HighwayRoundListReader;
  publish: (positions: PresenceHighway[]) => void;
  pollMs: number;
  onError?: (error: unknown) => void;
}): HighwayIndexer {
  let timer: NodeJS.Timeout | undefined;

  async function refresh(): Promise<void> {
    const records = await options.read();
    options.publish(records.map(toPresence).filter((position): position is PresenceHighway => position !== null));
  }

  return {
    refresh,
    start() {
      if (timer) return;
      timer = setInterval(() => void refresh().catch(options.onError), options.pollMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

function matchesDiscriminator(data: Uint8Array): boolean {
  return ROUND_DISCRIMINATOR.every((byte, index) => data[index] === byte);
}

export function decodeHighwayRound(roundPda: string, encodedData: string): HighwayRoundRecord | null {
  const data = Buffer.from(encodedData, "base64");
  if (data.length !== ROUND_ACCOUNT_SIZE || !matchesDiscriminator(data)) return null;
  return {
    roundPda,
    owner: bs58.encode(data.subarray(8, 40)),
    feed: bs58.encode(data.subarray(40, 72)),
    dir: data.readInt8(72),
    lev: data.readUInt32LE(73),
    deadlineTs: Number(data.readBigInt64LE(129)),
    status: data.readUInt8(151),
  };
}

interface RpcProgramAccount {
  pubkey: string;
  account: { data: [string, string] };
}

export function makeRpcHighwayRoundReader(
  rpcUrl = DEFAULT_HIGHWAY_RPC,
  request: typeof fetch = fetch,
): HighwayRoundListReader {
  return async () => {
    const response = await request(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          HIGHWAY_PROGRAM_ID,
          { commitment: "confirmed", encoding: "base64", filters: [{ dataSize: ROUND_ACCOUNT_SIZE }] },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Highway RPC returned HTTP ${response.status}`);
    const payload = await response.json() as { result?: RpcProgramAccount[]; error?: { message?: string } };
    if (!payload.result) throw new Error(payload.error?.message ?? "Highway RPC returned no result");
    return payload.result
      .map(({ pubkey, account }) => decodeHighwayRound(pubkey, account.data[0]))
      .filter((record): record is HighwayRoundRecord => record !== null);
  };
}
