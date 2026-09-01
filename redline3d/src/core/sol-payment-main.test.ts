import { beforeAll, describe, expect, test } from "vitest";

let source = "";

beforeAll(async () => {
  const fs = await import("node:fs/promises");
  source = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");
});

describe("main SOL crate payment wiring", () => {
  test("pays the configured treasury through the signed-in session wallet", () => {
    // The payment module is LAZY. A static import would drag @solana/web3.js into the eager play
    // bundle, which the live EVM rail never runs; the load sits behind the parked-wallet throw, so
    // only a real SOL payment on the solana rail can reach it. The wiring itself is unchanged.
    expect(source).not.toContain('import { payDevnetSol } from "./chain/sol-payment"');
    expect(source).toContain('await import("./chain/sol-payment")');
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

describe("main eager-bundle purity: the parked solana rail loads lazily", () => {
  // Every module under chain/ pulls @solana/web3.js (most also @coral-xyz/anchor) through
  // chain/config.ts. A single static import from main.ts puts all of it in the EAGER play chunk
  // that the live Robinhood Chain rail downloads on every boot. Value imports of chain/* must
  // therefore stay dynamic; `import type` erases at transform and is fine.
  test("main.ts holds no static value import of a chain/ module", () => {
    // `[^;]*` cannot cross a statement boundary, so a match is one real import statement.
    const statics = [...source.matchAll(/(?:^|\n)import\s+(?!type\b)(?:[^;]*?\bfrom\s*)?"(\.\/chain\/[^"]+)"/g)]
      .map((m) => m[1]);
    expect(statics).toEqual([]);
  });

  test("the three solana-only modules are reached through a dynamic import()", () => {
    expect(source).toContain('await import("./chain/sol-payment")');
    expect(source).toContain('await import("./chain/crate-roll")');
    expect(source).toContain('??= import("./chain/highway-verifier")');
  });

  test("the highway verifier load is gated on the solana rail", () => {
    expect(source).toContain('currentChainRail() !== "solana"');
  });
});
