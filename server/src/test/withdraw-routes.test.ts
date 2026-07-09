import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "mallory", "content-type": "application/json" };

describe("POST /v1/withdraw", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 withdrawals_disabled when withdrawals are off (default harness)", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "withdrawals_disabled" });
  });

  // a fully-wired processing path (send worker + admin approval trigger) is required to reserve.
  const READY = {
    withdrawProcessor: { async approveAndSend() { return { status: "sent" as const }; } },
    adminSecret: "test-admin-secret-0123456789abcdef",
  };

  it("returns 200 with the withdrawalId + state on a successful reserve", async () => {
    ctx = await makeTestDb({ ...READY, withdrawals: { async reserve() { return { status: "ok", withdrawalId: "w1", state: "awaiting_approval" }; } } });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ withdrawalId: "w1", state: "awaiting_approval" });
  });

  it("returns 409 with the reserve status on a non-ok reserve", async () => {
    ctx = await makeTestDb({ ...READY, withdrawals: { async reserve() { return { status: "capped" }; } } });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "capped" });
  });
});

describe("POST /v1/withdraw fail-closed without a processing path", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 503 withdrawals_unavailable and never reserves/debits when no processor is wired", async () => {
    let reserveCalled = false;
    ctx = await makeTestDb({
      // withdrawals subsystem present, but NO withdrawProcessor / adminSecret => no way to approve.
      withdrawals: { async reserve() { reserveCalled = true; return { status: "ok", withdrawalId: "w1", state: "awaiting_approval" }; } },
    });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "withdrawals_unavailable" });
    expect(reserveCalled).toBe(false); // fail-closed BEFORE reserve => nothing debited, funds not stranded
  });

  it("returns 503 withdrawals_unavailable when a processor exists but no admin approval path is configured", async () => {
    let reserveCalled = false;
    ctx = await makeTestDb({
      withdrawals: { async reserve() { reserveCalled = true; return { status: "ok", withdrawalId: "w1", state: "awaiting_approval" }; } },
      withdrawProcessor: { async approveAndSend() { return { status: "sent" }; } },
      // adminSecret intentionally unset => the approve route can never be reached => still stranded.
    });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "withdrawals_unavailable" });
    expect(reserveCalled).toBe(false);
  });
});

describe("POST /v1/admin/withdraw/:id/approve (admin-authorized)", () => {
  let ctx: TestCtx;
  const ADMIN = "test-admin-secret-0123456789abcdef";
  const ID = "00000000-0000-0000-0000-000000000000";
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 when no admin secret is configured (endpoint disabled)", async () => {
    ctx = await makeTestDb({ withdrawProcessor: { async approveAndSend() { return { status: "sent" }; } } });
    const res = await ctx.server.inject({ method: "POST", url: `/v1/admin/withdraw/${ID}/approve` });
    expect(res.statusCode).toBe(404);
  });

  it("rejects (401) without the admin secret", async () => {
    ctx = await makeTestDb({ adminSecret: ADMIN, withdrawProcessor: { async approveAndSend() { return { status: "sent" }; } } });
    const res = await ctx.server.inject({ method: "POST", url: `/v1/admin/withdraw/${ID}/approve` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects (401) with a wrong admin secret", async () => {
    ctx = await makeTestDb({ adminSecret: ADMIN, withdrawProcessor: { async approveAndSend() { return { status: "sent" }; } } });
    const res = await ctx.server.inject({
      method: "POST", url: `/v1/admin/withdraw/${ID}/approve`, headers: { "x-admin-secret": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("approves (200 sent) with the correct admin secret", async () => {
    let approved = "";
    ctx = await makeTestDb({
      adminSecret: ADMIN,
      withdrawProcessor: { async approveAndSend(id: string) { approved = id; return { status: "sent" }; } },
    });
    const res = await ctx.server.inject({
      method: "POST", url: `/v1/admin/withdraw/${ID}/approve`, headers: { "x-admin-secret": ADMIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "sent" });
    expect(approved).toBe(ID);
  });

  it("returns 409 with the status when the withdrawal is not approvable", async () => {
    ctx = await makeTestDb({
      adminSecret: ADMIN,
      withdrawProcessor: { async approveAndSend() { return { status: "not_approvable" }; } },
    });
    const res = await ctx.server.inject({
      method: "POST", url: `/v1/admin/withdraw/${ID}/approve`, headers: { "x-admin-secret": ADMIN },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not_approvable" });
  });
});
