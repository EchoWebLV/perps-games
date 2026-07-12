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

  test("renders a confirmed crate debit immediately instead of waiting for RPC", () => {
    expect(source).toContain('import { applyConfirmedWalletSpend } from "./core/wallet-balance-model"');
    expect(source).toContain("walletSolUnits = applyConfirmedWalletSpend(");
    const purchase = source.slice(source.indexOf("buyWithSol: async"), source.indexOf("// MagicBlock VRF", source.indexOf("buyWithSol: async")));
    expect(purchase.indexOf("renderKnownBalance();")).toBeGreaterThan(purchase.indexOf("await payDevnetSol"));
  });
});
