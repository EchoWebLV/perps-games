// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { createHowTo, howToSeen, markHowToSeen, type HowToOptions } from "./howto";
import type { KvStore } from "../core/identity";

const memStore = (): KvStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

beforeEach(() => {
  document.body.innerHTML = "";
});

function openHowTo(options?: HowToOptions) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const howto = createHowTo(host, options);
  howto.open();
  const panel = host.querySelector<HTMLElement>(".ht-panel");
  if (!panel) throw new Error("how-to panel did not render");
  return { host, howto, panel };
}

describe("how-to seen flag — durable once-ever", () => {
  test("starts unseen, stays seen after marking", () => {
    const store = memStore();
    expect(howToSeen(store)).toBe(false);
    markHowToSeen(store);
    expect(howToSeen(store)).toBe(true);
  });
  test("the seen mark persists across a fresh reader of the same store", () => {
    const store = memStore();
    markHowToSeen(store);
    expect(howToSeen(store)).toBe(true);
  });
});

describe("how-to gameplay cards", () => {
  test("shows the five approved cards in order", () => {
    const { panel } = openHowTo({ reducedMotion: () => true });
    const expected = [
      "Take the wheel",
      "Know the strip",
      "Call the market",
      "Choose your risk",
      "Bank it before you wreck",
    ];

    expect(panel.querySelectorAll(".ht-dot")).toHaveLength(5);
    for (const [index, title] of expected.entries()) {
      expect(panel.querySelector(".ht-t")?.textContent).toBe(title);
      if (index < expected.length - 1) {
        panel.querySelector<HTMLButtonElement>('[data-ht="next"]')?.click();
      }
    }
    expect(panel.querySelector('[data-ht="next"]')?.textContent).toBe("LET'S GO");
  });

  test("uses one real-media contract per card", () => {
    const { panel } = openHowTo({ reducedMotion: () => false });
    const video = panel.querySelector<HTMLVideoElement>(".ht-video");
    const sources = Array.from(video?.querySelectorAll("source") ?? []).map((source) => ({
      src: source.getAttribute("src"),
      type: source.getAttribute("type"),
    }));

    expect(video?.getAttribute("poster")).toBe("/tutorial/drive.webp");
    expect(video?.hasAttribute("muted")).toBe(true);
    expect(video?.hasAttribute("loop")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(sources).toEqual([
      { src: "/tutorial/drive.webm", type: "video/webm" },
      { src: "/tutorial/drive.mp4", type: "video/mp4" },
    ]);
    expect(panel.querySelector<HTMLImageElement>(".ht-poster")?.src).toContain("/tutorial/drive.webp");
  });

  test("explains all four functional lobby buildings on one card", () => {
    const { panel } = openHowTo({ reducedMotion: () => true });
    panel.querySelector<HTMLButtonElement>('[data-ht="next"]')?.click();

    const stops = Array.from(panel.querySelectorAll<HTMLElement>("[data-stop]")).map((stop) => ({
      key: stop.dataset.stop,
      label: stop.querySelector("b")?.textContent,
      copy: stop.querySelector("small")?.textContent,
    }));
    expect(stops).toEqual([
      { key: "track", label: "TRACK", copy: "start a price race" },
      { key: "garage", label: "GARAGE", copy: "choose your car" },
      { key: "upgrades", label: "UPGRADES", copy: "increase risk and time" },
      { key: "crates", label: "CRATES", copy: "unlock new cars" },
    ]);
  });

  test("finishes through the existing callback and closes", () => {
    const { panel, howto } = openHowTo({ reducedMotion: () => true });
    let closes = 0;
    howto.open(() => { closes += 1; });

    for (let index = 0; index < 5; index += 1) {
      panel.querySelector<HTMLButtonElement>('[data-ht="next"]')?.click();
    }

    expect(closes).toBe(1);
    expect(howto.isOpen()).toBe(false);
  });
});
