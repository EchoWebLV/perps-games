import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import buildApkScript from "./build-apk.sh?raw";
import { prepareNativeAssets } from "./prepare-native-assets.mjs";

describe("native asset preparation", () => {
  it("packages the game as root and excludes the landing shell", async () => {
    const dist = await mkdtemp(join(tmpdir(), "perps-rider-native-"));
    await mkdir(join(dist, "assets"));
    await mkdir(join(dist, "play"));
    await writeFile(join(dist, "index.html"), '<script src="/assets/landing-web.js"></script><link href="/assets/landing-web.css">');
    await writeFile(join(dist, "play", "index.html"), '<script src="/assets/play-game.js"></script>');
    await writeFile(join(dist, "assets", "landing-web.js"), "landing");
    await writeFile(join(dist, "assets", "landing-web.css"), "landing");
    await writeFile(join(dist, "assets", "play-game.js"), "game");

    await prepareNativeAssets(dist);

    expect(await readFile(join(dist, "index.html"), "utf8")).toContain("play-game.js");
    await expect(readFile(join(dist, "play", "index.html"), "utf8")).rejects.toThrow();
    await expect(readFile(join(dist, "assets", "landing-web.js"), "utf8")).rejects.toThrow();
    await expect(readFile(join(dist, "assets", "landing-web.css"), "utf8")).rejects.toThrow();
    expect(await readFile(join(dist, "assets", "play-game.js"), "utf8")).toBe("game");
  });

  it("runs native preparation before Capacitor sync", () => {
    expect(buildApkScript).toContain("node scripts/prepare-native-assets.mjs dist");
    expect(buildApkScript.indexOf("prepare-native-assets.mjs")).toBeLessThan(buildApkScript.indexOf("cap sync android"));
  });
});
