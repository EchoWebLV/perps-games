// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];

  constructor(readonly callback: IntersectionObserverCallback) {
    intersectionObservers.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const intersectionObservers: FakeIntersectionObserver[] = [];
let playVideo: ReturnType<typeof vi.spyOn>;
let pauseVideo: ReturnType<typeof vi.spyOn>;

function mediaQueryList(matches = false): MediaQueryList {
  const events = new EventTarget();
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

function mountLanding(hidden = false) {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.head.innerHTML = "";
  document.body.innerHTML = `
    <div data-motion-bg></div>
    <header data-site-header>
      <button type="button" aria-pressed="true" data-motion-toggle>MOTION ON</button>
      <button type="button" aria-expanded="false" data-menu-toggle>Menu</button>
      <nav data-menu><a href="#tutorial">Tutorial</a></nav>
    </header>
    <main>
      <section id="tutorial" data-motion-section="tutorial">
        <video data-tutorial-video></video>
        <div data-reveal>Reveal</div>
      </section>
      <section data-motion-section="technology"><div class="tech-scene"></div></section>
    </main>
    <img data-hero-art />
  `;
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

async function loadLanding() {
  return import("./main");
}

function markSectionVisible(section: "tutorial" | "technology") {
  const target = document.querySelector<HTMLElement>(`[data-motion-section="${section}"]`);
  if (!target) throw new Error(`Missing ${section} section`);
  const observer = intersectionObservers[0];
  const entry = { target, isIntersecting: true } as unknown as IntersectionObserverEntry;
  observer.callback([entry], observer as unknown as IntersectionObserver);
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  intersectionObservers.length = 0;
  sessionStorage.clear();
  mountLanding();
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryList()));
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  playVideo = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  pauseVideo = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("landing motion runtime", () => {
  it("applies reduced-motion behavior when the user pauses motion", async () => {
    await loadLanding();
    markSectionVisible("tutorial");
    expect(playVideo).toHaveBeenCalled();
    pauseVideo.mockClear();

    document.querySelector<HTMLButtonElement>("[data-motion-toggle]")?.click();

    expect(document.documentElement.classList.contains("motion-paused")).toBe(true);
    expect(document.querySelector("[data-motion-toggle]")?.getAttribute("aria-pressed")).toBe("false");
    expect(sessionStorage.getItem("perps-rider:motion-paused")).toBe("true");
    expect(pauseVideo).toHaveBeenCalled();
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const landingStylesheet = await readFile("src/landing/landing.css", "utf8");
    expect(landingStylesheet).toMatch(/html\.motion-paused \{[^}]*scroll-behavior: auto;[^}]*\}/);
    expect(landingStylesheet).toMatch(
      /html\.motion-paused\.landing-ready \[data-reveal\] \{[^}]*opacity: 1;[^}]*transform: none;[^}]*transition: none;[^}]*\}/,
    );
  });

  it("starts paused when the document is initially hidden", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });

    await loadLanding();

    expect(document.documentElement.classList.contains("motion-paused")).toBe(true);
    expect(document.querySelector("[data-motion-toggle]")?.getAttribute("aria-pressed")).toBe("false");
    expect(pauseVideo).toHaveBeenCalled();
  });

  it("keeps media, reveals, and navigation usable without IntersectionObserver", async () => {
    Reflect.deleteProperty(window, "IntersectionObserver");

    await loadLanding();

    expect(document.documentElement.classList.contains("landing-ready")).toBe(true);
    expect(document.documentElement.classList.contains("tech-motion-active")).toBe(true);
    expect(playVideo).toHaveBeenCalled();
    expect(document.querySelector("[data-reveal]")?.classList.contains("is-visible")).toBe(true);

    const menuToggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]")!;
    menuToggle.click();
    expect(menuToggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-menu]")?.classList.contains("is-open")).toBe(true);
  });
});
