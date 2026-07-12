import { describe, expect, it } from "vitest";
import landingHtml from "../../index.html?raw";
import manifestText from "../../public/manifest.webmanifest?raw";
import viteConfig from "../../vite.config.ts?raw";

const gamePages = import.meta.glob("../../play/index.html", {
  eager: true,
  import: "default",
  query: "?raw",
});
const landingScripts = import.meta.glob("./main.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});
const landingStyles = import.meta.glob("./landing.css", {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("Perps Rider landing shell", () => {
  it("makes root the landing page with a direct game link", () => {
    const html = landingHtml;

    expect(html).toContain("data-landing-page");
    expect(html).toContain('href="/play/"');
    expect(html).toContain("A real perp you drive");
    expect(html).toContain("You can lose your play amount");
    expect(html).not.toContain('/src/main.ts');
  });

  it("keeps the game shell at play and starts installed experiences there", () => {
    expect(Object.keys(gamePages)).toHaveLength(1);
    const gameHtml = Object.values(gamePages)[0] as string | undefined;
    expect(gameHtml).toContain('/src/main.ts');
    expect(JSON.parse(manifestText).start_url).toBe("/play/");
  });

  it("uses a lightweight landing bundle with a native game bypass", () => {
    expect(Object.keys(landingScripts)).toHaveLength(1);
    expect(Object.keys(landingStyles)).toHaveLength(1);
    const entry = Object.values(landingScripts)[0] as string | undefined;
    expect(entry).toContain('location.replace("/play/")');
    expect(entry).not.toContain('from "three"');
    expect(entry).not.toContain('from "../main"');
    expect(landingHtml).toContain('/src/landing/landing.css');
    expect(landingHtml).toContain('/src/landing/main.ts');
  });

  it("registers landing and play as explicit Vite entries", () => {
    expect(viteConfig).toContain('landing: fileURLToPath(new URL("index.html"');
    expect(viteConfig).toContain('play: fileURLToPath(new URL("play/index.html"');
  });

});
