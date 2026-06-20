import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("CORS", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("preflight allows the configured origin and the x-dev-user header", async () => {
    ctx = await makeTestDb({ corsOrigins: ["http://localhost:3000"] });
    const res = await ctx.server.inject({
      method: "OPTIONS",
      url: "/v1/me",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-dev-user",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-dev-user");
  });
});
