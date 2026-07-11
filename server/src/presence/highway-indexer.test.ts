import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import {
  decodeHighwayRound,
  makeHighwayIndexer,
  type HighwayRoundRecord,
} from "./highway-indexer.js";

const SOL_FEED = "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu";

function round(overrides: Partial<HighwayRoundRecord> = {}): HighwayRoundRecord {
  return {
    roundPda: "Round1111111111111111111111111111111111",
    owner: "Owner1111111111111111111111111111111111",
    feed: SOL_FEED,
    status: 1,
    deadlineTs: -1,
    dir: 1,
    lev: 250,
    ...overrides,
  };
}

describe("Highway chain indexer", () => {
  it("decodes the fixed MagicBlock Round account layout", () => {
    const data = Buffer.alloc(190);
    Buffer.from([87, 127, 165, 51, 73, 78, 116, 174]).copy(data, 0);
    Buffer.from(bs58.decode("ANcAfmuuko7VzC8vUZnn7bbg12BxyC9JNLCCJKQmbKf4")).copy(data, 8);
    Buffer.from(bs58.decode(SOL_FEED)).copy(data, 40);
    data.writeInt8(-1, 72);
    data.writeUInt32LE(250, 73);
    data.writeBigInt64LE(-475732569n, 129);
    data.writeUInt8(1, 151);

    expect(decodeHighwayRound("RoundPda", data.toString("base64"))).toEqual({
      roundPda: "RoundPda",
      owner: "ANcAfmuuko7VzC8vUZnn7bbg12BxyC9JNLCCJKQmbKf4",
      feed: SOL_FEED,
      dir: -1,
      lev: 250,
      deadlineTs: -475732569,
      status: 1,
    });
  });

  it("publishes only valid open positions and maps their feed to an asset", async () => {
    const publish = vi.fn();
    const read = vi.fn(async () => [
      round(),
      round({ roundPda: "ShortRound11111111111111111111111111111111", dir: -1 }),
      round({ roundPda: "ClosedRound1111111111111111111111111111111", status: 2 }),
      round({ roundPda: "TimedRound11111111111111111111111111111111", deadlineTs: 10 }),
      round({ roundPda: "BadFeed111111111111111111111111111111111", feed: "unknown" }),
      round({ roundPda: "BadLev1111111111111111111111111111111111", lev: 245 }),
    ]);
    const indexer = makeHighwayIndexer({ read, publish, pollMs: 2_000 });

    await indexer.refresh();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ asset: "SOL", dir: 1, lev: 250, carId: "Highway" }),
      expect.objectContaining({ asset: "SOL", dir: -1, lev: 250, carId: "Highway" }),
    ]);
    expect(publish.mock.calls[0]?.[0][0].laneSeed).toBeGreaterThanOrEqual(0);
    expect(publish.mock.calls[0]?.[0][0].laneSeed).toBeLessThanOrEqual(2);
  });

  it("preserves the last good snapshot when the RPC refresh fails", async () => {
    const publish = vi.fn();
    const read = vi
      .fn<() => Promise<HighwayRoundRecord[]>>()
      .mockResolvedValueOnce([round()])
      .mockRejectedValueOnce(new Error("RPC unavailable"));
    const indexer = makeHighwayIndexer({ read, publish, pollMs: 2_000 });

    await indexer.refresh();
    await expect(indexer.refresh()).rejects.toThrow("RPC unavailable");

    expect(publish).toHaveBeenCalledTimes(1);
  });
});
