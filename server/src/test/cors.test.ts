import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("CORS", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("preflight allows the configured origin and account trade headers", async () => {
    ctx = await makeTestDb({ corsOrigins: ["http://localhost:3000"] });
    const res = await ctx.server.inject({
      method: "OPTIONS",
      url: "/v1/trades",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-dev-user,x-trade-wallet",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-dev-user");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-trade-wallet");
  });

  it("allows both localhost and 127.0.0.1 in the default dev origin list", async () => {
    ctx = await makeTestDb({ corsOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"] });

    const res = await ctx.server.inject({
      method: "OPTIONS",
      url: "/v1/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "access-control-request-method": "POST",
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
  });
});
