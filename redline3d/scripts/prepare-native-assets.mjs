import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function prepareNativeAssets(distDirectory) {
  const dist = resolve(distDirectory);
  const landingPath = resolve(dist, "index.html");
  const gameDirectory = resolve(dist, "play");
  const gamePath = resolve(gameDirectory, "index.html");
  const [landingHtml, gameHtml] = await Promise.all([
    readFile(landingPath, "utf8"),
    readFile(gamePath, "utf8"),
  ]);

  const landingAssets = [...landingHtml.matchAll(/(?:src|href)=["']\/(assets\/landing-[^"']+)["']/g)]
    .map((match) => resolve(dist, match[1]));

  await writeFile(landingPath, gameHtml);
  await rm(gameDirectory, { recursive: true, force: true });
  await Promise.all(landingAssets.map((asset) => rm(asset, { force: true })));
}

if (process.argv[1]?.endsWith("prepare-native-assets.mjs")) {
  const distDirectory = process.argv[2];
  if (!distDirectory) throw new Error("Usage: node scripts/prepare-native-assets.mjs <dist-directory>");
  await prepareNativeAssets(distDirectory);
}
