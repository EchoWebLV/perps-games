import { describe, expect, it, vi } from "vitest";
import { CHAIN } from "./config";
import {
  deriveHighwayRoundPda,
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
