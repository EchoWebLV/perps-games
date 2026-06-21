import { describe, it, expect } from "vitest";
import { shortWallet } from "./auth-ui";

describe("shortWallet", () => {
  it("abbreviates a base58 address", () => {
    expect(shortWallet("So1anaAddr1111111111111111111111111111111")).toMatch(/^So1ana…/);
  });
  it("passes through short/empty", () => {
    expect(shortWallet("")).toBe("");
  });
});
