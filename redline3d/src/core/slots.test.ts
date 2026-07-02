import { describe, expect, test } from "vitest";
import { jackpotRoll, JACKPOT_CHANCE, JACKPOT_COINS } from "./slots";

describe("triple-7s jackpot roll (Slot Machine)", () => {
  test("pays 777 coins under the chance threshold, nothing at or above it", () => {
    expect(jackpotRoll(0)).toBe(JACKPOT_COINS);
    expect(jackpotRoll(JACKPOT_CHANCE - 1e-9)).toBe(JACKPOT_COINS);
    expect(jackpotRoll(JACKPOT_CHANCE)).toBe(0);
    expect(jackpotRoll(0.5)).toBe(0);
    expect(jackpotRoll(0.999)).toBe(0);
  });

  test("hits ~2% over a uniform sweep, and the prize is literally 777", () => {
    const M = 100000;
    let hits = 0;
    for (let i = 0; i < M; i++) if (jackpotRoll(i / M) > 0) hits++;
    expect(hits / M).toBeCloseTo(JACKPOT_CHANCE, 3);
    expect(JACKPOT_COINS).toBe(777); // triple 7s
  });
});
