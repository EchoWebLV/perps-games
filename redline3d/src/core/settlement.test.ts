import { describe, it, expect } from "vitest";
import { SimSettlement } from "./settlement";
import { CONFIG } from "./config";

describe("SimSettlement", () => {
  it("starts at START_BALANCE", () => {
    expect(new SimSettlement().balance()).toBe(CONFIG.START_BALANCE);
  });

  it("canAfford respects balance", () => {
    const s = new SimSettlement(1.5);
    expect(s.canAfford(1)).toBe(true);
    expect(s.canAfford(2)).toBe(false);
  });

  it("debit then credit moves the balance", () => {
    const s = new SimSettlement(100);
    s.debit(1);
    expect(s.balance()).toBe(99);
    s.credit(1.045);
    expect(s.balance()).toBeCloseTo(100.045, 6);
  });

  it("debit throws if unaffordable", () => {
    expect(() => new SimSettlement(0.5).debit(1)).toThrow();
  });

  it("reset returns to START_BALANCE", () => {
    const s = new SimSettlement(3);
    s.reset();
    expect(s.balance()).toBe(CONFIG.START_BALANCE);
  });
});
