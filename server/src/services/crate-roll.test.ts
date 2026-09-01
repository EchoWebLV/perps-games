import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { drawsFromSeed, makeCrateRoll } from "./crate-roll.js";

describe("drawsFromSeed", () => {
  it("is deterministic, uniform-ish in [0,1), and matches the published derivation", () => {
    const seed = Buffer.alloc(32, 7);
    const a = drawsFromSeed(seed, 3);
    expect(a).toEqual(drawsFromSeed(seed, 3));
    for (const d of a) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
    }
    const h = createHash("sha256").update(seed).update(Buffer.from([0])).digest();
    expect(a[0]).toBeCloseTo(h.readUInt32BE(0) / 2 ** 32, 12);
  });

  it("spreads draws across the unit interval (distinct indices, no clustering)", () => {
    const buckets = new Array(10).fill(0);
    for (let s = 0; s < 40; s++) {
      for (const d of drawsFromSeed(Buffer.alloc(32, s), 10)) buckets[Math.floor(d * 10)]++;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(0); // 400 draws — every decile must be hit
  });
});

describe("makeCrateRoll", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("commit → open reveals a seed matching the commitment; a commit is single-use", async () => {
    ctx = await makeTestDb();
    const user1 = (await ctx.users.upsertByExternalId("dev:roll-1")).id;
    const user2 = (await ctx.users.upsertByExternalId("dev:roll-2")).id;
    const svc = makeCrateRoll(ctx.db);

    const c = await svc.commit(user1);
    expect(c.commitment).toMatch(/^[0-9a-f]{64}$/);

    const opened = await svc.consume(user1, c.commitId, 3);
    const check = createHash("sha256")
      .update(Buffer.from(opened.seedHex, "hex"))
      .update(Buffer.from(opened.nonceHex, "hex"))
      .digest("hex");
    expect(check).toBe(c.commitment);
    expect(opened.commitment).toBe(c.commitment);
    expect(opened.draws).toHaveLength(3);
    expect(opened.draws).toEqual(drawsFromSeed(Buffer.from(opened.seedHex, "hex"), 3));

    await expect(svc.consume(user1, c.commitId, 3)).rejects.toThrow("commit_used");
    await expect(svc.consume(user2, c.commitId, 3)).rejects.toThrow("commit_not_found");
  });

  it("hides the seed until the open, and never repeats a commitment", async () => {
    ctx = await makeTestDb();
    const userId = (await ctx.users.upsertByExternalId("dev:roll-3")).id;
    const svc = makeCrateRoll(ctx.db);

    const commitments = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const c = await svc.commit(userId);
      // the published half is the ONLY thing a commit hands out — no seed, no nonce.
      expect(Object.keys(c).sort()).toEqual(["commitId", "commitment"]);
      commitments.add(c.commitment);
    }
    expect(commitments.size).toBe(8);
  });

  it("rejects an unknown commit id without leaking whether it exists", async () => {
    ctx = await makeTestDb();
    const userId = (await ctx.users.upsertByExternalId("dev:roll-4")).id;
    const svc = makeCrateRoll(ctx.db);
    await expect(svc.consume(userId, "00000000-0000-4000-8000-000000000000", 4))
      .rejects.toThrow("commit_not_found");
  });

  it("lets only one concurrent open consume a commit", async () => {
    ctx = await makeTestDb();
    const userId = (await ctx.users.upsertByExternalId("dev:roll-5")).id;
    const svc = makeCrateRoll(ctx.db);
    const c = await svc.commit(userId);

    const results = await Promise.allSettled([
      svc.consume(userId, c.commitId, 4),
      svc.consume(userId, c.commitId, 4),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toBe("commit_used");
  });
});
