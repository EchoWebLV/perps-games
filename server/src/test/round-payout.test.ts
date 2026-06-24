import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "alice", "content-type": "application/json" };

describe("round close direct payout", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("sends a winning cash payout from the vault to the user's wallet and clears the ledger credit", async () => {
    const sent: Array<{ destWallet: string; amountCents: number; idempotencyKey: string }> = [];
    ctx = await makeTestDb({
      stakeAsset: "cash",
      realMoney: { enabled: true, treasuryUsdcAta: "TreasuryAta111" },
      payoutSigner: {
        async signAndSend(input) {
          sent.push(input);
          return { txSig: "sig-payout", privyTxId: "privy-payout" };
        },
      },
    });
    ctx.feed.set("SOL", { price: 100, tsUs: 1_000_000 });
    const user = await ctx.users.upsertByExternalId("dev:alice");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");
    await ctx.ledger.credit(user.id, "cash", 100, "test_cash");

    const opened = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H, payload: { asset: "SOL", dir: 1, lev: 10, stake: 10 } });
    const roundId = opened.json().roundId as string;
    ctx.feed.set("SOL", { price: 105, tsUs: 5_000_000 });

    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/close", headers: H, payload: { roundId, reason: "cashout" } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payoutCoins: 14, payoutTxSig: "sig-payout", balance: 90 });
    expect(sent).toEqual([{ destWallet: "WalletAAA", amountCents: 14, idempotencyKey: `round-payout:${roundId}` }]);
  });
});
