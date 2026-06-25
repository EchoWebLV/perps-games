import { describe, expect, it } from "vitest";
import { makeSessionAuth } from "./session.js";

describe("makeSessionAuth", () => {
  const users = {
    async upsertByExternalId(externalId: string) {
      return { id: `user-for-${externalId}`, externalId, walletPublicKey: null } as any;
    },
  };

  it("issues and verifies an anonymous session token", async () => {
    const auth = makeSessionAuth({ users: users as any, secret: "s".repeat(32), now: () => 1000 });
    const issued = await auth.issueAnonymous();
    expect(issued.token.startsWith("v1.")).toBe(true);
    await expect(auth.verifyToken(issued.token)).resolves.toBe(issued.userId);
  });

  it("rejects a token whose payload was modified", async () => {
    const auth = makeSessionAuth({ users: users as any, secret: "s".repeat(32), now: () => 1000 });
    const issued = await auth.issueAnonymous();
    const parts = issued.token.split(".");
    const tampered = `${parts[0]}.${parts[1].replace(/.$/, parts[1].endsWith("a") ? "b" : "a")}.${parts[2]}`;
    await expect(auth.verifyToken(tampered)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    let now = 1000;
    const auth = makeSessionAuth({ users: users as any, secret: "s".repeat(32), now: () => now, ttlMs: 10 });
    const issued = await auth.issueAnonymous();
    now = 1011;
    await expect(auth.verifyToken(issued.token)).resolves.toBeNull();
  });
});
