import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { createServer } from "vite";

export const BUILDINGS = ["track", "garage", "upgrades", "crates"];
const OUTPUT_FILES = {
  track: "building-track.webp",
  garage: "building-garage.webp",
  upgrades: "building-upgrades.webp",
  crates: "building-crates.webp",
};
const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(root, "public", "assets", "landing");

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  try { candidates.unshift(puppeteer.executablePath()); } catch { /* use system candidates */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* try next */ }
  }
  throw new Error("Chrome not found. Set CHROME_PATH to an executable browser.");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const vite = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port.");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({ headless: true, executablePath: await findChrome() });
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 720, deviceScaleFactor: 1 });

    for (const building of BUILDINGS) {
      await page.goto(`${origin}/building-renderer.html?building=${building}`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
      const canvas = await page.$("canvas");
      if (!canvas) throw new Error(`Renderer produced no canvas for ${building}.`);
      await canvas.screenshot({
        path: join(outputDir, OUTPUT_FILES[building]),
        type: "webp",
        omitBackground: true,
      });
    }
  } finally {
    await browser?.close();
    await vite.close();
  }
}

await main();
