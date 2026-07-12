import { beforeAll, describe, expect, test } from "vitest";

let source = "";

beforeAll(async () => {
  const fs = await import("node:fs/promises");
  source = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");
});

describe("main SOL crate payment wiring", () => {
  test("pays the configured treasury through the signed-in session wallet", () => {
    expect(source).toContain('import { payDevnetSol } from "./chain/sol-payment"');
    expect(source).toContain("VITE_CRATE_TREASURY_PUBKEY");
    expect(source).toMatch(/buyWithSol:\s*async \([^)]*priceSol[^)]*\)/);
    expect(source).toContain("payDevnetSol(wallet, CRATE_TREASURY, priceSol)");
    expect(source).not.toContain("onBuyUsd:");
  });
});
