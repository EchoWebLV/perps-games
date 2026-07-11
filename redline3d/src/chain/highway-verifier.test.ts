import { describe, expect, it, vi } from "vitest";
import { CHAIN } from "./config";
import {
  deriveHighwayRoundPda,
  selectRemoteHighwayPlayers,
  verifyHighwayPresence,
  type HighwayRoundRecord,
} from "./highway-verifier";

const WALLET = "FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM";
const ROUND = deriveHighwayRoundPda(WALLET)!;
const advertised = {
  wallet: WALLET,
  roundPda: ROUND,
  asset: "SOL" as const,
  dir: 1 as const,
  lev: 250,
  laneSeed: 2,
  carId: "Orion",
};

const record = (over: Partial<HighwayRoundRecord> = {}): HighwayRoundRecord => ({
  owner: WALLET,
  feed: CHAIN.FEEDS.SOL.toBase58(),
  status: 1,
  deadlineTs: -123,
  dir: 1,
  lev: 250,
  ...over,
});

describe("verifyHighwayPresence", () => {
  it("selects the other wallet's same-asset position without duplicating the local car", () => {
    const other = { ...advertised, wallet: "11111111111111111111111111111111" };
    const players = [
      { id: "mine", name: "mine", carId: "Highway", x: 0, z: 0, heading: 0, speed: 0, highway: advertised },
      { id: "other", name: "other", carId: "Highway", x: 0, z: 0, heading: 0, speed: 0, highway: other },
      { id: "btc", name: "btc", carId: "Highway", x: 0, z: 0, heading: 0, speed: 0, highway: { ...other, asset: "BTC" as const } },
    ];

    expect(selectRemoteHighwayPlayers(players, WALLET, "SOL").map(({ id }) => id)).toEqual(["other"]);
  });

  it("accepts only a matching live open-ended Round", async () => {
    const read = vi.fn(async () => record());
    await expect(verifyHighwayPresence(advertised, read)).resolves.toEqual(advertised);
    expect(read).toHaveBeenCalledWith(ROUND);
  });

  it.each([
    ["owner", { owner: "11111111111111111111111111111111" }],
    ["timed", { deadlineTs: 123 }],
    ["settled", { status: 2 }],
    ["feed", { feed: CHAIN.FEEDS.BTC.toBase58() }],
    ["direction", { dir: -1 }],
    ["leverage", { lev: 150 }],
  ] as const)("rejects a mismatched %s", async (_name, override) => {
    await expect(verifyHighwayPresence(advertised, async () => record(override))).resolves.toBeNull();
  });

  it("rejects an advertisement for the wrong Round PDA before reading", async () => {
    const read = vi.fn(async () => record());
    await expect(verifyHighwayPresence({ ...advertised, roundPda: CHAIN.FEEDS.BTC.toBase58() }, read)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects invalid wallet keys and missing Round accounts", async () => {
    await expect(verifyHighwayPresence({ ...advertised, wallet: "not-a-wallet" }, async () => record())).resolves.toBeNull();
    await expect(verifyHighwayPresence(advertised, async () => null)).resolves.toBeNull();
  });
});
