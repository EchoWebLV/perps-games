import { describe, it, expect } from "vitest";
import { usd, sol, sol3 } from "./money";

describe("usd — cent-denominated money formatting (1 coin = $0.01)", () => {
  it("renders a whole-dollar faucet balance", () => {
    expect(usd(10000)).toBe("$100.00");
  });
  it("renders dollars and cents", () => {
    expect(usd(125)).toBe("$1.25");
  });
  it("renders a sub-dime amount (no lost cents)", () => {
    expect(usd(5)).toBe("$0.05");
  });
  it("renders zero", () => {
    expect(usd(0)).toBe("$0.00");
  });
  it("rounds a fractional-cent live prediction to 2 decimals", () => {
    expect(usd(130.7)).toBe("$1.31");
  });
});

describe("sol / sol3 — centi-SOL formatting (1 unit = 0.01 SOL)", () => {
  it("sol renders 2 decimals (whole centi-SOL steps)", () => {
    expect(sol(5)).toBe("0.05 SOL");
    expect(sol(100)).toBe("1.00 SOL");
  });
  it("sol3 renders 3 decimals so sub-cent SOL survives a cash-out", () => {
    expect(sol3(5)).toBe("0.050 SOL");       // whole centi-SOL → trailing 0
    expect(sol3(4.75)).toBe("0.048 SOL");    // 0.0475 SOL cash-out, not hidden as 0.04/0.05
    expect(sol3(0.5)).toBe("0.005 SOL");     // half a centi-SOL still visible
    expect(sol3(0)).toBe("0.000 SOL");
  });
});
