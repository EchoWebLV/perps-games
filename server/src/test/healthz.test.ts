import { describe, it, expect } from "vitest";
import { buildServer } from "../http/server.js";

describe("healthz", () => {
  it("returns ok", async () => {
    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await server.close();
  });
});
