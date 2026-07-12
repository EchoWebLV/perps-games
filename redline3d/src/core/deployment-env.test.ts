import { describe, expect, it } from "vitest";
import developmentEnv from "../../.env.development?raw";
import productionEnv from "../../.env.production?raw";
import dockerfile from "../../Dockerfile?raw";
import apkBuildScript from "../../scripts/build-apk.sh?raw";

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

  it("threads Privy player configuration into the Docker production build", () => {
    expect(dockerfile).toContain("ARG VITE_PRIVY_APP_ID");
    expect(dockerfile).toContain("ARG VITE_WALLET");
    expect(dockerfile).toContain("ARG VITE_SOLANA_CLUSTER");
    expect(dockerfile.indexOf("ARG VITE_PRIVY_APP_ID")).toBeLessThan(dockerfile.indexOf("RUN npm run build"));
  });

  it("refreshes the public APK inside Railway's persistent models volume", () => {
    expect(dockerfile).toContain("/opt/perps-rider.apk");
    expect(dockerfile).toContain("cp /opt/perps-rider.apk /usr/share/caddy/models/perps-rider.apk");
    expect(dockerfile).toContain("exec caddy run");
  });

  it("refuses to build a native APK without auth and a WebView-safe Solana RPC", () => {
    expect(apkBuildScript).toContain("require_vite_env VITE_PRIVY_APP_ID");
    expect(apkBuildScript).toContain("require_vite_env VITE_BASE_RPC");
  });
});
