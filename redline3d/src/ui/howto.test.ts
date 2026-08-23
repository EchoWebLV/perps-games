// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHowTo, howToSeen, markHowToSeen, type HowToOptions } from "./howto";
import type { KvStore } from "../core/identity";

const memStore = (): KvStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("how-to seen flag", () => {
  test("keeps the guest flag once per device", () => {
    const store = memStore();
    expect(howToSeen(store)).toBe(false);
    markHowToSeen(store);
    expect(howToSeen(store)).toBe(true);
  });

  test("keeps separate completion flags for separate signed-in accounts", () => {
    const store = memStore();
    markHowToSeen(store, "WalletAccountA");

    expect(howToSeen(store, "WalletAccountA")).toBe(true);
    expect(howToSeen(store, "WalletAccountB")).toBe(false);
    expect(howToSeen(store)).toBe(false);
  });

  test("preserves case-sensitive Solana wallet namespaces", () => {
    const store = memStore();
    markHowToSeen(store, "AbCd123");

    expect(howToSeen(store, "AbCd123")).toBe(true);
    expect(howToSeen(store, "abcd123")).toBe(false);
  });
});

describe("how-to gameplay cards", () => {
  // The first-run walkthrough opens from the identity-gate callbacks while home (30) is still up, and it
  // runs BEFORE the welcome crate, so it must never sit under home or the crate shop (34) — masked there,
  // onDone never fires and markHowToSeen is never reached. The access wall (40) and the driver-name /
  // trade-history modals (42) are hard gates and stay ABOVE the walkthrough.
  test("hosts above home and the crate shop, below the access wall", () => {
    const { host, panel } = openHowTo({ reducedMotion: () => true });
    host.style.pointerEvents = "none";
    const overlay = panel.parentElement as HTMLElement;

    expect(overlay.style.position).toBe("fixed");
    expect(overlay.style.pointerEvents).toBe("auto");
    const layer = Number(overlay.style.zIndex);
    expect(layer).toBeGreaterThan(34); // home + identity gate (30) and the crate shop (34)
    expect(layer).toBeLessThan(40);    // access wall (and the 42 modals above it)
  });

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
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
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

  test("plays only the active clip and pauses it before paging", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const { panel } = openHowTo({ reducedMotion: () => false });

    expect(play).toHaveBeenCalledTimes(1);
    expect(panel.querySelector(".ht-preload source")?.getAttribute("src"))
      .toBe("/tutorial/lobby.webm");
    panel.querySelector<HTMLButtonElement>('[data-ht="next"]')?.click();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
  });

  test("uses posters only when reduced motion is requested", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { panel } = openHowTo({ reducedMotion: () => true });

    expect(panel.querySelector(".ht-poster")).not.toBeNull();
    expect(panel.querySelector(".ht-video")).toBeNull();
    expect(panel.querySelector(".ht-preload")).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  test("shows a play control when autoplay is rejected", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new DOMException("autoplay blocked", "NotAllowedError"));
    const { panel } = openHowTo({ reducedMotion: () => false });

    await Promise.resolve();
    await Promise.resolve();
    expect(panel.querySelector<HTMLButtonElement>(".ht-play")?.hidden).toBe(false);
  });

  test("falls back to the poster when every source fails", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const { panel } = openHowTo({ reducedMotion: () => false });
    const video = panel.querySelector<HTMLVideoElement>(".ht-video");

    video?.dispatchEvent(new Event("error"));
    expect(panel.querySelector(".ht-media")?.classList.contains("is-fallback")).toBe(true);
    expect(video?.hidden).toBe(true);
    expect(panel.querySelector('[data-ht="next"]')).not.toBeNull();
  });

  test("keeps terminal fallback hidden after pending playback rejects", async () => {
    let rejectPlay!: (reason?: unknown) => void;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      new Promise<void>((_, reject) => { rejectPlay = reject; })
    );
    const { panel } = openHowTo({ reducedMotion: () => false });
    const frame = panel.querySelector<HTMLElement>(".ht-media");
    const video = panel.querySelector<HTMLVideoElement>(".ht-video");
    const playButton = panel.querySelector<HTMLButtonElement>(".ht-play");

    video?.dispatchEvent(new Event("error"));
    rejectPlay(new DOMException("playback failed", "NotSupportedError"));
    await Promise.resolve();
    await Promise.resolve();

    expect(frame?.classList.contains("is-fallback")).toBe(true);
    expect(video?.hidden).toBe(true);
    expect(playButton?.hidden).toBe(true);
  });
});
