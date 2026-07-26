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
let reduceMotionQuery: MediaQueryList;
let desktopQuery: MediaQueryList;

function mediaQueryList(matches: boolean, media: string): MediaQueryList {
  const events = new EventTarget();
  return {
    matches,
    media,
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
    <header data-nav>
      <button type="button" aria-expanded="false" data-menu-toggle>Menu</button>
      <nav data-menu><a href="#perps">Perps</a></nav>
      <div class="cluster3d">
        <model-viewer src="/assets/hero3d/clown-car.glb"></model-viewer>
        <model-viewer data-mvsrc="/assets/hero3d/dragon.glb"></model-viewer>
      </div>
    </header>
    <main>
      <section id="lobby" data-motion-section="lobby">
        <video data-tutorial-video></video>
        <div data-reveal>Reveal</div>
      </section>
      <section id="perps" data-motion-section="perps">
        <video data-tutorial-video></video>
      </section>
      <div class="gcard" data-tilt></div>
    </main>
  `;
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

async function loadLanding() {
  return import("./main");
}

function videoIn(section: string) {
  const video = document.querySelector<HTMLVideoElement>(`[data-motion-section="${section}"] video`);
  if (!video) throw new Error(`Missing video in ${section} section`);
  return video;
}

function markSection(section: string, isIntersecting = true) {
  const target = document.querySelector<HTMLElement>(`[data-motion-section="${section}"]`);
  if (!target) throw new Error(`Missing ${section} section`);
  const observer = intersectionObservers[0]; // main.ts creates the section observer first
  const entry = { target, isIntersecting } as unknown as IntersectionObserverEntry;
  observer.callback([entry], observer as unknown as IntersectionObserver);
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  intersectionObservers.length = 0;
  mountLanding();
  reduceMotionQuery = mediaQueryList(false, "(prefers-reduced-motion: reduce)");
  desktopQuery = mediaQueryList(true, "(min-width: 768px)");
  vi.stubGlobal("matchMedia", vi.fn((query: string) =>
    query.includes("reduced-motion") ? reduceMotionQuery : desktopQuery,
  ));
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  playVideo = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  pauseVideo = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("landing runtime", () => {
  it("reacts to live OS reduced-motion changes", async () => {
    await loadLanding();
    markSection("lobby");
    expect(playVideo).toHaveBeenCalled();
    playVideo.mockClear();
    pauseVideo.mockClear();

    reduceMotionQuery.dispatchEvent(Object.assign(new Event("change"), { matches: true }));
    expect(document.documentElement.classList.contains("motion-paused")).toBe(true);
    expect(pauseVideo).toHaveBeenCalled();

    reduceMotionQuery.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
    expect(document.documentElement.classList.contains("motion-paused")).toBe(false);
    expect(playVideo).toHaveBeenCalled();
  });

  it("plays and pauses each video section independently", async () => {
    await loadLanding();

    const lobbyVideo = videoIn("lobby");
    const perpsVideo = videoIn("perps");
    const lobbyPlay = vi.spyOn(lobbyVideo, "play").mockResolvedValue(undefined);
    const lobbyPause = vi.spyOn(lobbyVideo, "pause").mockImplementation(() => undefined);
    const perpsPlay = vi.spyOn(perpsVideo, "play").mockResolvedValue(undefined);
    const perpsPause = vi.spyOn(perpsVideo, "pause").mockImplementation(() => undefined);

    markSection("lobby", true);
    expect(lobbyPlay).toHaveBeenCalled();
    expect(perpsPlay).not.toHaveBeenCalled();

    markSection("perps", true);
    expect(perpsPlay).toHaveBeenCalled();

    lobbyPlay.mockClear();
    lobbyPause.mockClear();
    perpsPause.mockClear();

    markSection("lobby", false);
    expect(lobbyPause).toHaveBeenCalled();
    expect(lobbyPlay).not.toHaveBeenCalled();
    expect(perpsPause).not.toHaveBeenCalled();
  });

  it("starts paused when the OS initially requests reduced motion", async () => {
    reduceMotionQuery = mediaQueryList(true, "(prefers-reduced-motion: reduce)");
    await loadLanding();

    expect(document.documentElement.classList.contains("motion-paused")).toBe(true);
    expect(pauseVideo).toHaveBeenCalled();
  });

  it("starts paused when the document is initially hidden", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await loadLanding();

    expect(document.documentElement.classList.contains("motion-paused")).toBe(true);
    expect(pauseVideo).toHaveBeenCalled();
  });

  it("promotes flanking hero GLBs on desktop, but never on phones", async () => {
    await loadLanding();
    const flank = document.querySelector<HTMLElement>("model-viewer[data-mvsrc]")!;
    expect(flank.getAttribute("src")).toBe("/assets/hero3d/dragon.glb");

    // a phone-width viewport must NOT promote the flanks (only the eager center GLB loads)
    vi.resetModules();
    mountLanding();
    desktopQuery = mediaQueryList(false, "(min-width: 768px)");
    await loadLanding();
    const phoneFlank = document.querySelector<HTMLElement>("model-viewer[data-mvsrc]")!;
    expect(phoneFlank.getAttribute("src")).toBeNull();
  });

  it("initializes reveals and the burger nav without IntersectionObserver", async () => {
    Reflect.deleteProperty(window, "IntersectionObserver");
    await loadLanding();

    expect(document.documentElement.classList.contains("landing-ready")).toBe(true);
    expect(document.querySelector("[data-reveal]")?.classList.contains("in")).toBe(true);

    const toggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]")!;
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-menu]")?.classList.contains("is-open")).toBe(true);

    document.querySelector<HTMLAnchorElement>("[data-menu] a")!.click(); // a nav link closes the menu
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-menu]")?.classList.contains("is-open")).toBe(false);
  });

  it("keeps section video motion inactive without IntersectionObserver", async () => {
    Reflect.deleteProperty(window, "IntersectionObserver");
    await loadLanding();

    expect(playVideo).not.toHaveBeenCalled();
    expect(pauseVideo).toHaveBeenCalled();
  });
});
