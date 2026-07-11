import { describe, expect, it } from "vitest";
import developmentEnv from "../../.env.development?raw";
import productionEnv from "../../.env.production?raw";

function apiBase(env: string): string | undefined {
  return env.match(/^VITE_API_BASE=(.+)$/m)?.[1]?.trim();
}

describe("Railway-only API configuration", () => {
  it.each([
    ["development", developmentEnv],
    ["production", productionEnv],
  ])("routes %s builds to the Railway server", (_mode, env) => {
    expect(apiBase(env)).toBe("https://redline-server-production-f413.up.railway.app");
  });
});
