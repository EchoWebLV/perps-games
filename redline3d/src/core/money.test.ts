import { describe, it, expect } from "vitest";
import { usd } from "./money";

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
