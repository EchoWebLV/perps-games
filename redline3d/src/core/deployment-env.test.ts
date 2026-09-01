import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import developmentEnv from "../../.env.development?raw";
import productionEnv from "../../.env.production?raw";
import dockerfile from "../../Dockerfile?raw";
import apkBuildScript from "../../scripts/build-apk.sh?raw";

function apiBase(env: string): string | undefined {
  return env.match(/^VITE_API_BASE=(.+)$/m)?.[1]?.trim();
}

async function runApkBuild(apiUrl: string) {
  const sandbox = await mkdtemp(join(tmpdir(), "perps-rider-apk-env-"));
  const project = join(sandbox, "project");
  const launcherBin = join(sandbox, "launcher-bin");
  const javaHome = join(sandbox, "java");
  const androidHome = join(sandbox, "android-sdk");
  const buildMarker = join(sandbox, "npm-build-invoked");
  const nodeUrlModule = "node:url";
  const childProcessModule = "node:child_process";
  const processModule = "node:process";
  const { fileURLToPath } = await import(/* @vite-ignore */ nodeUrlModule) as typeof import("node:url");
  const { spawnSync } = await import(/* @vite-ignore */ childProcessModule) as typeof import("node:child_process");
  const { execPath } = await import(/* @vite-ignore */ processModule) as typeof import("node:process");
  const apkBuildPath = fileURLToPath(new URL("../../scripts/build-apk.sh", import.meta.url));

  try {
    await Promise.all([
      mkdir(join(project, "scripts"), { recursive: true }),
      mkdir(join(project, "android"), { recursive: true }),
      mkdir(launcherBin, { recursive: true }),
      mkdir(join(javaHome, "bin"), { recursive: true }),
      mkdir(join(androidHome, "platform-tools"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(launcherBin, "dirname"), '#!/bin/sh\nprintf "%s\\n" "$APK_TEST_PROJECT/scripts"\n'),
      writeFile(join(javaHome, "bin", "java"), "#!/bin/sh\nexit 0\n"),
      writeFile(join(androidHome, "platform-tools", "adb"), "#!/bin/sh\nexit 0\n"),
      writeFile(join(javaHome, "bin", "npm"), '#!/bin/sh\n: > "$APK_BUILD_MARKER"\nexit 91\n'),
      symlink(execPath, join(javaHome, "bin", "node")),
    ]);
    await Promise.all([
      chmod(join(launcherBin, "dirname"), 0o755),
      chmod(join(javaHome, "bin", "java"), 0o755),
      chmod(join(androidHome, "platform-tools", "adb"), 0o755),
      chmod(join(javaHome, "bin", "npm"), 0o755),
    ]);

    const result = spawnSync("/bin/bash", [apkBuildPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        ANDROID_HOME: androidHome,
        APK_BUILD_MARKER: buildMarker,
        APK_TEST_PROJECT: project,
        JAVA_HOME: javaHome,
        PATH: `${launcherBin}:/usr/bin:/bin`,
        VITE_API_BASE: apiUrl,
        VITE_BASE_RPC: "https://rpc.example.invalid",
        VITE_PRIVY_APP_ID: "dummy-privy-app-id",
      },
    });
    const buildInvoked = await access(buildMarker).then(() => true, () => false);

    return { buildInvoked, result };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
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

  // The server is the only price source and the only holder of the oracle credential.
  // A VITE_ var is baked into the bundle, so any Pyth key here would ship to every browser.
  it("bakes no Pyth credential into the client build", () => {
    expect(dockerfile).not.toContain("VITE_PYTH_API_KEY");
    expect(developmentEnv).not.toContain("VITE_PYTH_API_KEY");
    expect(productionEnv).not.toContain("VITE_PYTH_API_KEY");
    expect(apkBuildScript).not.toContain("VITE_PYTH_API_KEY");
  });

  it("refuses to build a native APK without auth and a WebView-safe Solana RPC", () => {
    expect(apkBuildScript).toContain("require_vite_env VITE_PRIVY_APP_ID");
    expect(apkBuildScript).toContain("require_vite_env VITE_BASE_RPC");
  });

  it.each([
    ["localhost", "http://localhost:8080"],
    ["uppercase URL scheme", "HTTP://localhost:8080"],
    ["uppercase localhost", "http://LOCALHOST:8080"],
    ["IPv4 loopback", "http://127.0.0.1:8080"],
    ["IPv4 loopback subnet", "http://127.0.0.2:8080"],
    ["IPv6 loopback", "http://[::1]:8080"],
    ["expanded IPv6 loopback", "http://[0:0:0:0:0:0:0:1]:8080"],
    ["userinfo with localhost", "http://player:secret@localhost:8080"],
  ])("rejects an exported %s API endpoint before invoking the web build", async (_host, apiUrl) => {
    const { buildInvoked, result } = await runApkBuild(apiUrl);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/loopback API endpoints? (?:are|is) invalid for APK builds/i);
    expect(buildInvoked).toBe(false);
  });

  it("allows an exported Railway API endpoint to reach the web build", async () => {
    const { buildInvoked, result } = await runApkBuild("https://redline-server-production-f413.up.railway.app");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(91);
    expect(buildInvoked).toBe(true);
  });
});

// The EVM rail's build-time truth lives in three places that must agree: the two .env files vite
// reads at build, and the Dockerfile ARG/ENV pair a deploy overrides them with. A var declared in
// only some of them is the failure mode this guards — the build stays green while the client
// silently falls back to a default network, which for VITE_EVM_CHAIN means real money.
describe("Robinhood Chain rail configuration", () => {
  const RAIL_VARS = ["VITE_CHAIN_RAIL", "VITE_EVM_CHAIN", "VITE_EVM_USDC_ADDRESS"] as const;

  // Anchored to the start of a line so a commented-out `# VITE_x=` can never satisfy a check.
  function value(env: string, key: string): string | undefined {
    return env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
  }

  it.each(RAIL_VARS)("declares %s in both client env files", (key) => {
    expect(value(developmentEnv, key)).toBeDefined();
    expect(value(productionEnv, key)).toBeDefined();
  });

  // evm/rail.ts treats anything other than "solana" as evm, but pin it so the rail is readable
  // from the env file rather than inferred from a default that could later flip.
  it("pins both builds to the evm rail", () => {
    expect(value(developmentEnv, "VITE_CHAIN_RAIL")).toBe("evm");
    expect(value(productionEnv, "VITE_CHAIN_RAIL")).toBe("evm");
  });

  // evm/chain.ts maps these to chain ids 46630 (testnet) and 4663 (mainnet).
  it("points development at the testnet and production at the mainnet", () => {
    expect(value(developmentEnv, "VITE_EVM_CHAIN")).toBe("testnet");
    expect(value(productionEnv, "VITE_EVM_CHAIN")).toBe("mainnet");
  });

  // The USDC contract is deploy-time truth. A committed address would be a guess, and a wrong
  // token address sends deposits nowhere — so the var is declared but deliberately blank.
  it("declares the USDC address without guessing one", () => {
    expect(value(developmentEnv, "VITE_EVM_USDC_ADDRESS")).toBe("");
    expect(value(productionEnv, "VITE_EVM_USDC_ADDRESS")).toBe("");
  });

  it.each(RAIL_VARS)("threads %s through the Docker production build", (key) => {
    expect(dockerfile).toMatch(new RegExp(`^\\s*ARG ${key}$`, "m"));
    expect(dockerfile).toMatch(new RegExp(`${key}=\\$${key}`));
    expect(dockerfile.indexOf(`ARG ${key}`)).toBeLessThan(dockerfile.indexOf("RUN npm run build"));
  });
});
