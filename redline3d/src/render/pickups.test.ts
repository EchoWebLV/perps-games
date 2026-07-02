import { describe, expect, test } from "vitest";
import { CART_COIN_RATE, coinMult, createPickups, recycleSpan } from "./pickups";

describe("coinMult tiers (Vaporwave rainbow coins)", () => {
  test("maps r-ranges to the right multipliers", () => {
    expect(coinMult(0)).toBe(5);
    expect(coinMult(0.029)).toBe(5);
    expect(coinMult(0.03)).toBe(3);
    expect(coinMult(0.089)).toBe(3);
    expect(coinMult(0.09)).toBe(2);
    expect(coinMult(0.209)).toBe(2);
    expect(coinMult(0.21)).toBe(1);
    expect(coinMult(0.999)).toBe(1);
  });

  test("distribution is ~3% / 6% / 12% / 79% over a uniform sweep", () => {
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
    const M = 100000;
    for (let i = 0; i < M; i++) counts[coinMult(i / M)]++;
    expect(counts[5] / M).toBeCloseTo(0.03, 3);
    expect(counts[3] / M).toBeCloseTo(0.06, 3);
    expect(counts[2] / M).toBeCloseTo(0.12, 3);
    expect(counts[1] / M).toBeCloseTo(0.79, 3);
  });
});

describe("coin rate (Cart Rod +33% coins on the road)", () => {
  test("recycleSpan shrinks by the rate → coin density rises by exactly the rate", () => {
    expect(recycleSpan(1)).toBeCloseTo(990, 6); // 9 coins × 110 spacing (stock road)
    expect(recycleSpan(CART_COIN_RATE)).toBeCloseTo(990 / CART_COIN_RATE, 6);
    expect(CART_COIN_RATE).toBeCloseTo(4 / 3, 9); // a third more coins
  });

  test("update() recycles a passed coin a shorter span back at cart rate (denser road)", () => {
    const p = createPickups();
    p.setCoinRate(CART_COIN_RATE);
    const flat = () => 0;
    const before = p.group.children.map((c) => c.position.z);
    // +300z: only the nearest coin (z≈-218) crosses RECYCLE=22 and wraps
    p.update(300, 1, 0, flat, false);
    expect(p.group.children[0].position.z).toBeCloseTo(before[0] + 300 - recycleSpan(CART_COIN_RATE), 6);
    expect(p.group.children[1].position.z).toBeCloseTo(before[1] + 300, 6); // no wrap — just drifted
  });
});
