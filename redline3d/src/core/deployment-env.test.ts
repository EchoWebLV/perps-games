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
    expect(dockerfile).toContain("ARG VITE_PYTH_API_KEY");
    expect(dockerfile.indexOf("ARG VITE_PRIVY_APP_ID")).toBeLessThan(dockerfile.indexOf("RUN npm run build"));
    expect(dockerfile.indexOf("ARG VITE_PYTH_API_KEY")).toBeLessThan(dockerfile.indexOf("RUN npm run build"));
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
