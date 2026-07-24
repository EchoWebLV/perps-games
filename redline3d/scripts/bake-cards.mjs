// Bake each car's card art to a PNG (public/cards/<slug>.png).
//
// Reuses the game's OWN renderer: it boots Vite, opens the garage in headless
// Chrome (which renders each GLB to a card image), then saves those images to
// disk. Run it whenever you add/retune a car so the garage can load light PNGs
// instead of the heavy GLBs.
//
// One-time setup:  npm i -D puppeteer      (downloads a headless Chromium)
// Then:            npm run bake:cards
import puppeteer from "puppeteer";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// Prefer an already-installed Chrome (no 170MB download needed)
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
].find((p) => existsSync(p));

const PORT = 5188;
const ORIGIN = `http://localhost:${PORT}`;
// The GAME lives at /play/ (root "/" is the marketing landing page — no garage there). `?nohome=1` is a
// DEV-only boot hook in main.ts that skips the Slopwheels home overlay and lands in the lobby, so the
// hamburger → Garage chrome this script drives is on screen.
const BASE = `${ORIGIN}/play/?nohome=1`;
const OUT = "public/cards";

const waitForServer = (url, tries = 80) =>
  new Promise((resolve, reject) => {
    const tick = () =>
      http
        .get(url, (res) => { res.destroy(); resolve(); })
        .on("error", () => (--tries > 0 ? setTimeout(tick, 500) : reject(new Error("vite did not start"))));
    tick();
  });

console.log("▶ starting vite…");
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const cleanup = () => { try { vite.kill(); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

let browser;
try {
  await waitForServer(BASE);
  console.log("▶ launching headless chrome…");
  browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME || undefined,
    userDataDir: mkdtempSync(join(tmpdir(), "bake-chrome-")),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.warn("  [page]", m.text()));
  // Seed a guest identity BEFORE any page script runs, so the first-launch identity gate (which would
  // otherwise cover the hamburger) never appears. Runs in the localhost origin on navigation; the
  // about:blank pass throws on localStorage and is swallowed. Matches src/ui/identity.ts IDENT_KEY.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem("raider.identity", JSON.stringify({ name: "bake_bot", mode: "guest" })); } catch {}
  });
  await page.goto(BASE, { waitUntil: "networkidle2" });

  // open the menu, go to the Garage — the app renders each car to a card image
  await page.waitForSelector('[aria-label="Open menu"]', { timeout: 20000 });
  await page.click('[aria-label="Open menu"]');
  await page.waitForSelector(".gmenu-item");
  await page.evaluate(() => {
    [...document.querySelectorAll(".gmenu-item")].find((b) => /Garage/i.test(b.textContent))?.click();
  });

  console.log("▶ waiting for the garage to render every car…");
  await page.waitForFunction(
    () => {
      const arts = [...document.querySelectorAll(".gcard-art")];
      return arts.length > 0 && arts.every((a) => a.src && a.src.startsWith("data:"));
    },
    { timeout: 180000 }
  );

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll(".gcard")]
      .filter((e) => !e.classList.contains("locked"))
      .map((e) => ({
        name: e.querySelector(".gtitle-name")?.textContent || "",
        src: e.querySelector(".gcard-art")?.src || "",
      }))
  );

  mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (const c of cards) {
    if (!c.src.startsWith("data:")) continue;
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const buf = Buffer.from(c.src.split(",")[1], "base64");
    writeFileSync(`${OUT}/${slug}.png`, buf);
    console.log(`  ✓ ${OUT}/${slug}.png  (${(buf.length / 1024).toFixed(0)} KB)`);
    n++;
  }
  console.log(`✔ baked ${n} card image${n === 1 ? "" : "s"} → ${OUT}/`);
} catch (err) {
  console.error("✖ bake failed:", err.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  cleanup();
}
