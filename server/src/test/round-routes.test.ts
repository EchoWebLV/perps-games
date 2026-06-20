import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

let ctx: TestCtx;
const H = (user: string) => ({ "x-dev-user": user });

beforeEach(async () => {
  ctx = await makeTestDb();
  ctx.feed.set("SOL", { price: 100, tsUs: 1_000_000 });
  await ctx.server.inject({ method: "POST", url: "/v1/dev/grant-coins", headers: H("alice"), payload: { amount: 100 } });
});
afterEach(async () => {
  await ctx.close();
});

describe("POST /v1/round/open", () => {
  it("opens a round and escrows the stake", async () => {
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("alice"), payload: { asset: "SOL", dir: 1, lev: 50, stake: 10 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roundId).toBeTruthy();
    expect(body.entryRaw).toBe(100);
    const bal = await ctx.server.inject({ method: "GET", url: "/v1/balance", headers: H("alice") });
    expect(bal.json().balance).toBe(90);
  });

  it("402 when the user can't afford the stake", async () => {
    // 'broke' is a fresh dev user with no coins → a valid stake of 10 is unaffordable
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("broke"), payload: { asset: "SOL", dir: 1, lev: 10, stake: 10 } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("insufficient_balance");
  });

  it("503 when the feed is halted", async () => {
    ctx.feed.setHealthy("SOL", false);
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("alice"), payload: { asset: "SOL", dir: 1, lev: 50, stake: 10 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("feed_halt");
  });

  it("409 when a round is already open", async () => {
    await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("alice"), payload: { asset: "SOL", dir: 1, lev: 50, stake: 10 } });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("alice"), payload: { asset: "SOL", dir: 1, lev: 50, stake: 10 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("round_already_open");
  });

  it("400 on a bad body", async () => {
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("alice"), payload: { asset: "DOGE", dir: 1, lev: 50, stake: 10 } });
    expect(res.statusCode).toBe(400);
  });

  it("401 without the dev-user header", async () => {
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/open", payload: { asset: "SOL", dir: 1, lev: 50, stake: 10 } });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/round/close (+ action)", () => {
  async function openRound() {
    const r = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("alice"), payload: { asset: "SOL", dir: 1, lev: 10, stake: 10 } });
    return r.json().roundId as string;
  }

  it("settles a winning round through the HTTP surface", async () => {
    const roundId = await openRound();
    ctx.feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/close", headers: H("alice"), payload: { roundId, reason: "cashout" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe("cashout");
    expect(body.payoutCoins).toBe(14);
    expect(body.balance).toBe(104);
  });

  it("a flip action then close reflects the segment in the payout", async () => {
    const roundId = await openRound();
    ctx.feed.set("SOL", { price: 110, tsUs: 3_000_000 });
    const a = await ctx.server.inject({ method: "POST", url: "/v1/round/action", headers: H("alice"), payload: { roundId, actionId: "f1", kind: "flip", dir: -1 } });
    expect(a.statusCode).toBe(200);
    ctx.feed.set("SOL", { price: 105, tsUs: 6_000_000 });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/close", headers: H("alice"), payload: { roundId, reason: "cashout" } });
    expect(res.json().payoutCoins).toBeGreaterThan(10);
  });

  it("double-close returns the same body and pays once", async () => {
    const roundId = await openRound();
    ctx.feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    const first = await ctx.server.inject({ method: "POST", url: "/v1/round/close", headers: H("alice"), payload: { roundId, reason: "cashout" } });
    const second = await ctx.server.inject({ method: "POST", url: "/v1/round/close", headers: H("alice"), payload: { roundId, reason: "cashout" } });
    expect(second.json().payoutCoins).toBe(first.json().payoutCoins);
    expect(second.json().balance).toBe(first.json().balance);
  });

  it("503 closing on a halted feed", async () => {
    const roundId = await openRound();
    ctx.feed.setHealthy("SOL", false);
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/close", headers: H("alice"), payload: { roundId, reason: "cashout" } });
    expect(res.statusCode).toBe(503);
  });

  it("404 closing an unknown round", async () => {
    const res = await ctx.server.inject({ method: "POST", url: "/v1/round/close", headers: H("alice"), payload: { roundId: "00000000-0000-0000-0000-000000000000", reason: "cashout" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/round/:id", () => {
  it("returns the round for its owner", async () => {
    const r = await ctx.server.inject({ method: "POST", url: "/v1/round/open", headers: H("alice"), payload: { asset: "SOL", dir: 1, lev: 10, stake: 10 } });
    const roundId = r.json().roundId as string;
    const res = await ctx.server.inject({ method: "GET", url: `/v1/round/${roundId}`, headers: H("alice") });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("open");
  });

  it("404 for an unknown id", async () => {
    const res = await ctx.server.inject({ method: "GET", url: "/v1/round/00000000-0000-0000-0000-000000000000", headers: H("alice") });
    expect(res.statusCode).toBe(404);
  });
});
