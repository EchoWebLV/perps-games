import { describe, expect, test, vi } from "vitest";
import { CART_COIN_RATE, coinMult, createPickups, recycleSpan, SCRAP_GRADES, scrapGradeIdx } from "./pickups";

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

describe("coin magnet (Magnet: vacuum every coin)", () => {
  const flat = () => 0;
  // park every coin far behind the target so only children[0] can enter the catch window
  const isolate = (p: ReturnType<typeof createPickups>, target: { x: number; z: number }) => {
    p.group.children.forEach((c, i) => c.position.set(i === 0 ? target.x : 0, 1.7, i === 0 ? target.z : -9000));
  };
  // drift the target coin through the catch window in small steps (z += speed*dt each frame)
  const sweep = (p: ReturnType<typeof createPickups>, carX: number, collect = true) => {
    let caught = 0;
    for (let i = 0; i < 12; i++) caught += p.update(0.05, 60, carX, flat, collect).count; // +3z/step
    return caught;
  };

  test("a far-lane coin is pulled into the car's lane and caught (no steering needed)", () => {
    const p = createPickups();
    p.setMagnet(true);
    isolate(p, { x: 8, z: -20 });            // coin two lanes over from a car sitting at x=0
    const caught = sweep(p, 0);
    expect(caught).toBe(1);                   // magnet vacuumed it in
    expect(p.group.children[0].visible).toBe(false);
    expect(Math.abs(p.group.children[0].position.x)).toBeLessThan(3.2); // bent toward the lane before catch
  });

  test("without the magnet the same far-lane coin slips past uncaught", () => {
    const p = createPickups();
    isolate(p, { x: 8, z: -20 });            // magnet OFF (default)
    const caught = sweep(p, 0);
    expect(caught).toBe(0);
    expect(p.group.children[0].visible).toBe(true);
    expect(p.group.children[0].position.x).toBeCloseTo(8, 6); // never pulled — held its lane
  });

  test("catches from either side — a coin left of a right-sitting car still curves in", () => {
    const p = createPickups();
    p.setMagnet(true);
    isolate(p, { x: -8, z: -20 });
    expect(sweep(p, 8)).toBe(1);              // car parked far right, coin far left → still swept up
  });

  test("magnet does nothing while parked (collect=false) — no showroom vacuuming", () => {
    const p = createPickups();
    p.setMagnet(true);
    isolate(p, { x: 8, z: -20 });
    expect(sweep(p, 0, false)).toBe(0);
    expect(p.group.children[0].position.x).toBeCloseTo(8, 6); // untouched while idle
  });
});

describe("pickup collision follows the rendered car body", () => {
  const flat = () => 0;
  const isolate = (p: ReturnType<typeof createPickups>, target: { x: number; z: number }) => {
    p.group.children.forEach((c, i) => {
      c.visible = true;
      c.position.set(i === 0 ? target.x : 0, 1.7, i === 0 ? target.z : -9000);
    });
  };

  test("collects a coin swept across the yawed front corner during a hard turn", () => {
    const p = createPickups();
    isolate(p, { x: 4, z: -18 });

    const hit = p.update(0.05, 60, 0, flat, true, {
      previousX: 0,
      yaw: -0.4,
      z: -12,
    });

    expect(hit.count).toBe(1);
    expect(p.group.children[0].visible).toBe(false);
  });

  test("collects a centered coin that crosses the whole car in one fast frame", () => {
    const p = createPickups();
    isolate(p, { x: 0, z: -20 });

    const hit = p.update(0.05, 300, 0, flat, true, {
      previousX: 0,
      yaw: 0,
      z: -12,
    });

    expect(hit.count).toBe(1);
    expect(p.group.children[0].visible).toBe(false);
  });

  test("does not collect a coin beyond the yawed car footprint", () => {
    const p = createPickups();
    isolate(p, { x: 8, z: -18 });

    const hit = p.update(0.05, 60, 0, flat, true, {
      previousX: 0,
      yaw: -0.4,
      z: -12,
    });

    expect(hit.count).toBe(0);
    expect(p.group.children[0].visible).toBe(true);
  });
});

describe("scrap pickups (every 3rd–5th pickup comes up scrap instead of a coin)", () => {
  const flat = () => 0;

  test("min gap: with a fixed roll of 0 (gap 3), exactly every 3rd pickup laid is scrap", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0); // randGap → 3
    try {
      const p = createPickups();
      const kinds = p.group.children.map((c) => !!c.userData.scrap);
      // 9 coins laid at init, toNextScrap starting at 3 → scrap lands on indices 2, 5, 8
      expect(kinds).toEqual([false, false, true, false, false, true, false, false, true]);
    } finally { spy.mockRestore(); }
  });

  test("max gap: a roll of ~1 (gap 5) leaves the road mostly coins", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.999); // randGap → 5
    try {
      const p = createPickups();
      expect(p.group.children.filter((c) => c.userData.scrap).length).toBe(1); // gap 5 over 9 → one piece
    } finally { spy.mockRestore(); }
  });

  test("a caught scrap piece banks to hit.scrap, never to coin count/value", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0); // children[2] scrap, children[0] coin
    try {
      const p = createPickups();
      // isolate one pickup in front of the car (x=0), park the rest far behind, drift it through
      const sweepOne = (idx: number) => {
        p.group.children.forEach((c, i) => { c.visible = true; c.position.set(0, 1.7, i === idx ? -20 : -9000); });
        let scrap = 0, count = 0, value = 0;
        for (let s = 0; s < 12; s++) { const h = p.update(0.05, 60, 0, flat, true); scrap += h.scrap; count += h.count; value += h.value; }
        return { scrap, count, value };
      };
      expect(sweepOne(2)).toEqual({ scrap: 1, count: 0, value: 0 }); // a shard (roll 0) → 1 scrap pt, no coins
      expect(sweepOne(0)).toEqual({ scrap: 0, count: 1, value: 1 }); // coin → count + value, no scrap
    } finally { spy.mockRestore(); }
  });

  test("scrapGradeIdx maps r-ranges to grades by 60/30/10 weight", () => {
    expect(scrapGradeIdx(0)).toBe(0);     // shard
    expect(scrapGradeIdx(0.59)).toBe(0);
    expect(scrapGradeIdx(0.60)).toBe(1);  // chunk
    expect(scrapGradeIdx(0.89)).toBe(1);
    expect(scrapGradeIdx(0.90)).toBe(2);  // hunk
    expect(scrapGradeIdx(0.999)).toBe(2);
  });

  test("the grades are worth escalating scrap points (1 / 3 / 5)", () => {
    expect(SCRAP_GRADES.map((g) => g.pts)).toEqual([1, 3, 5]);
  });

  test("a caught chunk banks its 3 points, not 1", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.6); // grade → chunk (3 pts); scrap lands on idx 3 & 7
    try {
      const p = createPickups();
      p.group.children.forEach((c, i) => { c.visible = true; c.position.set(0, 1.7, i === 3 ? -20 : -9000); });
      let scrap = 0;
      for (let s = 0; s < 12; s++) scrap += p.update(0.05, 60, 0, () => 0, true).scrap;
      expect(scrap).toBe(3);
    } finally { spy.mockRestore(); }
  });
});
