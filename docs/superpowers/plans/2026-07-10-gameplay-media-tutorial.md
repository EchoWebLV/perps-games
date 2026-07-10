# Gameplay Media Tutorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six emoji-led tutorial cards with five Perps Raider-styled cards that teach through short recordings of real gameplay, including one quick tour of all four functional lobby buildings.

**Architecture:** Keep the existing `ui/howto.ts` overlay, triggers, seen flag, and navigation. Card metadata will supply the copy and media paths, while a small renderer inside the same module owns the active video, poster fallback, reduced-motion behavior, and next-card metadata preload. A reproducible FFmpeg script will encode five raw gameplay captures into WebM, MP4, and WebP assets.

**Tech Stack:** TypeScript, vanilla DOM, Vitest with jsdom, Vite public assets, HTML5 video, FFmpeg 8.

## Global Constraints

- Keep the current dark violet panel, cyan border/glow, `Chakra Petch`, `SKIP`, progress dots, back arrow, green next button, swipe, arrow keys, and Escape behavior.
- Keep the current first-run trigger after the identity/access gate and before the welcome crate.
- Keep hamburger-menu replay and reset replay to card one.
- Use five cards in this order: drive, lobby, market side, leverage, cash out.
- Use the four real lobby colors: Track `#14f195`, Garage `#27e7ff`, Upgrades `#ffd166`, Crates `#ff39c0`.
- Use actual game recordings, not recreated illustration or animation.
- Each clip is 5 to 8 seconds, 16:9, at most 640 by 360, 24 fps unless 30 fps is required, and has no audio track.
- Each WebM is at most 600,000 bytes. Each MP4 is at most 900,000 bytes. Both video formats together are at most 7,500,000 bytes.
- Use WebM first, MP4 fallback, and a WebP poster with the same basename.
- Under `prefers-reduced-motion: reduce`, render posters only and do not autoplay.
- A missing, blocked, or failed video must never block copy, navigation, Skip, or close behavior.
- Do not modify `main.ts`, tutorial triggers, gameplay, round mechanics, economy, wallets, sign-in, crates, upgrades, or lobby behavior.

## File Structure

- Modify `redline3d/src/ui/howto.ts`: five-card metadata, media markup, matching styles, video lifecycle, poster fallback, and reduced-motion behavior.
- Modify `redline3d/src/ui/howto.test.ts`: seen-flag tests plus card order, lobby labels, navigation, playback, failure, and reduced-motion contracts.
- Create `redline3d/src/ui/howto-assets.test.ts`: committed asset presence and byte-budget checks.
- Create `redline3d/scripts/encode-tutorial-media.sh`: deterministic WebM, MP4, and WebP encoding from five raw `.mov` captures.
- Create `redline3d/public/tutorial/*`: five WebM clips, five MP4 clips, and five WebP posters.
- Leave `redline3d/src/main.ts` and `redline3d/src/ui/carpicker.ts` unchanged.

---

### Task 1: Replace the card content and lock the DOM contract

**Files:**
- Modify: `redline3d/src/ui/howto.ts`
- Modify: `redline3d/src/ui/howto.test.ts`

**Interfaces:**
- Consumes: existing `createHowTo(parent)`, `HowTo.open(onClose?)`, `howToSeen`, and `markHowToSeen`.
- Produces: `createHowTo(parent, options?)`, `HowToOptions`, five fixed cards, `.ht-video`, `.ht-poster`, `.ht-preload`, `.ht-play`, and `[data-stop]` DOM contracts for Task 2 tests.

- [ ] **Step 1: Add DOM setup and a tutorial helper to the test file**

Change the Vitest import and add the setup/helper immediately below `memStore` in `redline3d/src/ui/howto.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";
import { createHowTo, howToSeen, markHowToSeen, type HowToOptions } from "./howto";
```

```ts
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
```

Keep both existing seen-flag tests unchanged.

- [ ] **Step 2: Write the failing five-card and lobby tests**

Append these tests to `redline3d/src/ui/howto.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the focused tests and verify the new contract fails**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts
```

Expected: FAIL because `HowToOptions` does not exist, the first title is still `Drive`, and the current overlay has six dots.

- [ ] **Step 4: Replace the card model and card data**

In `redline3d/src/ui/howto.ts`, replace the current `Card` interface and `CARDS` array with:

```ts
interface LobbyStop {
  key: "track" | "garage" | "upgrades" | "crates";
  label: string;
  copy: string;
  color: string;
}

interface Card {
  title: string;
  body: string;
  media: string;
  poster: string;
  stops?: LobbyStop[];
}

const CARDS: Card[] = [
  {
    title: "Take the wheel",
    body: "Hold to drive. Drag left or right to steer.",
    media: "/tutorial/drive",
    poster: "/tutorial/drive.webp",
  },
  {
    title: "Know the strip",
    body: "Four stops. One quick tour.",
    media: "/tutorial/lobby",
    poster: "/tutorial/lobby.webp",
    stops: [
      { key: "track", label: "TRACK", copy: "start a price race", color: "#14f195" },
      { key: "garage", label: "GARAGE", copy: "choose your car", color: "#27e7ff" },
      { key: "upgrades", label: "UPGRADES", copy: "increase risk and time", color: "#ffd166" },
      { key: "crates", label: "CRATES", copy: "unlock new cars", color: "#ff39c0" },
    ],
  },
  {
    title: "Call the market",
    body: "Long if price goes up. Short if it goes down. Then tap GO.",
    media: "/tutorial/market-side",
    poster: "/tutorial/market-side.webp",
  },
  {
    title: "Choose your risk",
    body: "More revs means more leverage. Bigger wins, faster wrecks.",
    media: "/tutorial/leverage",
    poster: "/tutorial/leverage.webp",
  },
  {
    title: "Bank it before you wreck",
    body: "Cash out to keep the win. Hit liquidation and lose the play amount.",
    media: "/tutorial/cash-out",
    poster: "/tutorial/cash-out.webp",
  },
];

export interface HowToOptions {
  reducedMotion?: () => boolean;
}
```

- [ ] **Step 5: Add the final media and lobby markup helpers**

Add these helpers immediately after the `HowToOptions` interface:

```ts
function stopsHtml(stops: LobbyStop[] | undefined): string {
  if (!stops) return "";
  return `<div class="ht-stops">${stops.map((stop) =>
    `<div class="ht-stop" data-stop="${stop.key}" style="--stop:${stop.color}">` +
      `<b>${stop.label}</b><small>${stop.copy}</small>` +
    `</div>`
  ).join("")}</div>`;
}

function mediaHtml(card: Card, next: Card | undefined, reducedMotion: boolean): string {
  const active = reducedMotion ? "" :
    `<video class="ht-video" muted loop playsinline autoplay preload="auto" poster="${card.poster}">` +
      `<source src="${card.media}.webm" type="video/webm">` +
      `<source src="${card.media}.mp4" type="video/mp4">` +
    `</video>` +
    `<button class="ht-play" data-ht="play" aria-label="Play tutorial clip" hidden>▶</button>`;
  const preload = !reducedMotion && next ?
    `<video class="ht-preload" aria-hidden="true" muted preload="metadata">` +
      `<source src="${next.media}.webm" type="video/webm">` +
    `</video>` : "";
  return `<div class="ht-media">` +
    `<img class="ht-poster" src="${card.poster}" alt="">` +
    active + preload +
  `</div>`;
}
```

- [ ] **Step 6: Replace the emoji styles with matching media styles**

In `injectStyles`, keep the existing animation, panel, Skip, title, dots, and navigation rules. Remove `.ht-ic` and `.ht-sub`, change `.ht-panel` and `.ht-body`, and add the media/lobby rules so the final relevant CSS is:

```css
.ht-panel{width:min(400px,94vw);max-height:calc(100dvh - 40px);overflow:auto;padding:20px 20px 16px;display:flex;flex-direction:column;align-items:center;gap:12px;background:rgba(12,10,26,.96);border:1.5px solid rgba(39,231,255,.4);border-radius:18px;box-shadow:0 0 34px rgba(39,231,255,.22);position:relative}
.ht-media{position:relative;width:100%;aspect-ratio:16/9;max-height:202px;margin-top:8px;overflow:hidden;border:1px solid rgba(39,231,255,.28);border-radius:12px;background:#080713;box-shadow:inset 0 0 24px rgba(0,0,0,.55);animation:htIn .35s ease both}
.ht-poster,.ht-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ht-poster{z-index:0}.ht-video{z-index:1}.ht-video[hidden]{display:none}
.ht-play{position:absolute;z-index:2;left:50%;top:50%;transform:translate(-50%,-50%);width:52px;height:52px;border:1px solid rgba(39,231,255,.65);border-radius:50%;background:rgba(8,7,19,.88);color:#fff;cursor:pointer;font:800 18px/1 'Chakra Petch',ui-monospace,monospace;box-shadow:0 0 18px rgba(39,231,255,.34)}
.ht-play[hidden],.ht-preload{display:none}
.ht-body{min-height:0;text-align:center;font:500 15px/1.45 'Chakra Petch',ui-monospace,monospace;color:#c9cce0;animation:htIn .35s ease .08s both}
.ht-stops{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;width:100%}
.ht-stop{padding:8px 7px;border:1px solid color-mix(in srgb,var(--stop) 45%,transparent);border-radius:8px;background:rgba(255,255,255,.04);text-align:left}
.ht-stop b{display:block;color:var(--stop);font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.07em}
.ht-stop small{display:block;margin-top:4px;color:#9d9aaf;font:500 9px/1.2 'Chakra Petch',ui-monospace,monospace}
@media(max-height:620px){.ht-media{max-height:150px}.ht-panel{gap:9px}}
```

- [ ] **Step 7: Render the new cards through the existing overlay**

Change the function signature and replace the current `render` function:

```ts
export function createHowTo(parent: HTMLElement, options: HowToOptions = {}): HowTo {
```

```ts
  const reducedMotion = options.reducedMotion?.() ??
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

  const render = () => {
    const card = CARDS[i];
    const last = i === CARDS.length - 1;
    panel.innerHTML =
      `<button class="ht-skip" data-ht="skip" aria-label="Skip">SKIP</button>` +
      mediaHtml(card, CARDS[i + 1], reducedMotion) +
      `<div class="ht-t">${card.title}</div>` +
      `<div class="ht-body">${card.body}</div>` +
      stopsHtml(card.stops) +
      `<div class="ht-dots">${CARDS.map((_, index) =>
        `<span class="ht-dot${index === i ? " on" : ""}"></span>`
      ).join("")}</div>` +
      `<div class="ht-nav">` +
        `<button class="ht-prev" data-ht="prev"${i === 0 ? " disabled" : ""}>‹</button>` +
        `<button class="ht-next" data-ht="next">${last ? "LET'S GO" : "NEXT ›"}</button>` +
      `</div>`;
  };
```

Leave close, paging, swipe, keyboard controls, seen-flag helpers, and the returned `HowTo` API unchanged in this task.

- [ ] **Step 8: Run the focused tests**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts
```

Expected: PASS with 6 tests.

- [ ] **Step 9: Typecheck and commit the card redesign**

Run:

```bash
cd redline3d
npx tsc --noEmit
```

Expected: exit 0.

Commit only the tutorial source and test:

```bash
git add redline3d/src/ui/howto.ts redline3d/src/ui/howto.test.ts
git commit -m "feat(tutorial): replace text cards with gameplay media"
```

---

### Task 2: Add playback lifecycle, reduced motion, and failure fallback

**Files:**
- Modify: `redline3d/src/ui/howto.ts`
- Modify: `redline3d/src/ui/howto.test.ts`

**Interfaces:**
- Consumes: `.ht-video`, `.ht-poster`, `.ht-play`, `.ht-preload`, `HowToOptions.reducedMotion`, and the existing `render`, `go`, and `close` functions from Task 1.
- Produces: one active playing video, previous-video pause on page change/close, poster-only reduced motion, visible replay affordance after autoplay rejection, and `.is-fallback` after terminal video failure.

- [ ] **Step 1: Extend the test imports for media spies**

Change the Vitest import in `redline3d/src/ui/howto.test.ts` to:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
```

Add after the existing `beforeEach`:

```ts
afterEach(() => {
  vi.restoreAllMocks();
});
```

- [ ] **Step 2: Write failing lifecycle and fallback tests**

Append inside `describe("how-to gameplay cards", ...)`:

```ts
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
```

- [ ] **Step 3: Run the focused tests and verify lifecycle failures**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts
```

Expected: the reduced-motion test passes from Task 1; lifecycle tests fail because render does not call `play`, pause the old clip, reveal the play button, or mark fallback state.

- [ ] **Step 4: Add active-media state and helpers**

In `createHowTo`, add these variables and helpers after `let closer` and before `render`:

```ts
  let activeVideo: HTMLVideoElement | null = null;
  let activePlay: HTMLButtonElement | null = null;

  const pauseActive = () => {
    activeVideo?.pause();
    activeVideo = null;
    activePlay = null;
  };

  const playActive = () => {
    const video = activeVideo;
    const playButton = activePlay;
    if (!video || !playButton) return;
    const attempt = video.play();
    void attempt.then(() => {
      if (video === activeVideo) playButton.hidden = true;
    }).catch(() => {
      if (video === activeVideo) playButton.hidden = false;
    });
  };

  const activateMedia = () => {
    const frame = panel.querySelector<HTMLElement>(".ht-media");
    activeVideo = panel.querySelector<HTMLVideoElement>(".ht-video");
    activePlay = panel.querySelector<HTMLButtonElement>(".ht-play");
    if (!frame || !activeVideo || !activePlay) return;

    const video = activeVideo;
    const playButton = activePlay;
    video.addEventListener("error", () => {
      if (video !== activeVideo) return;
      frame.classList.add("is-fallback");
      video.hidden = true;
      playButton.hidden = true;
    }, { once: true });
    playActive();
  };
```

- [ ] **Step 5: Wire the helpers into render, close, and the play button**

Make `pauseActive()` the first statement in `render`, and make `activateMedia()` the final statement after assigning `panel.innerHTML`:

```ts
  const render = () => {
    pauseActive();
    const card = CARDS[i];
    const last = i === CARDS.length - 1;
    panel.innerHTML =
      `<button class="ht-skip" data-ht="skip" aria-label="Skip">SKIP</button>` +
      mediaHtml(card, CARDS[i + 1], reducedMotion) +
      `<div class="ht-t">${card.title}</div>` +
      `<div class="ht-body">${card.body}</div>` +
      stopsHtml(card.stops) +
      `<div class="ht-dots">${CARDS.map((_, index) =>
        `<span class="ht-dot${index === i ? " on" : ""}"></span>`
      ).join("")}</div>` +
      `<div class="ht-nav">` +
        `<button class="ht-prev" data-ht="prev"${i === 0 ? " disabled" : ""}>‹</button>` +
        `<button class="ht-next" data-ht="next">${last ? "LET'S GO" : "NEXT ›"}</button>` +
      `</div>`;
    activateMedia();
  };
```

Replace `close` with:

```ts
  const close = () => {
    pauseActive();
    overlay.style.display = "none";
    const cb = closer;
    closer = undefined;
    cb?.();
  };
```

Add the play branch before the Skip branch in the existing panel click handler:

```ts
    if (k === "play") playActive();
    else if (k === "skip") close();
```

Do not change the remaining previous/next branches.

- [ ] **Step 6: Run focused tests, TypeScript, and commit**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts
npx tsc --noEmit
```

Expected: all 10 tutorial tests pass and TypeScript exits 0.

Commit:

```bash
git add redline3d/src/ui/howto.ts redline3d/src/ui/howto.test.ts
git commit -m "feat(tutorial): manage clip playback and fallbacks"
```

---

### Task 3: Encode and validate the five real gameplay loops

**Files:**
- Create: `redline3d/scripts/encode-tutorial-media.sh`
- Create: `redline3d/src/ui/howto-assets.test.ts`
- Create: `redline3d/public/tutorial/drive.webm`
- Create: `redline3d/public/tutorial/drive.mp4`
- Create: `redline3d/public/tutorial/drive.webp`
- Create: `redline3d/public/tutorial/lobby.webm`
- Create: `redline3d/public/tutorial/lobby.mp4`
- Create: `redline3d/public/tutorial/lobby.webp`
- Create: `redline3d/public/tutorial/market-side.webm`
- Create: `redline3d/public/tutorial/market-side.mp4`
- Create: `redline3d/public/tutorial/market-side.webp`
- Create: `redline3d/public/tutorial/leverage.webm`
- Create: `redline3d/public/tutorial/leverage.mp4`
- Create: `redline3d/public/tutorial/leverage.webp`
- Create: `redline3d/public/tutorial/cash-out.webm`
- Create: `redline3d/public/tutorial/cash-out.mp4`
- Create: `redline3d/public/tutorial/cash-out.webp`

**Interfaces:**
- Consumes: the five basenames referenced by Task 1 and five raw `.mov` recordings from the real game.
- Produces: 15 Vite public assets at the exact URLs rendered by `howto.ts`, plus a repeatable encoding command and a CI-safe byte-budget test.

- [ ] **Step 1: Write the failing asset budget test**

Create `redline3d/src/ui/howto-assets.test.ts`:

```ts
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const BASENAMES = ["drive", "lobby", "market-side", "leverage", "cash-out"] as const;
const LIMITS = { webm: 600_000, mp4: 900_000, webp: 200_000 } as const;

function sizeOf(base: string, extension: keyof typeof LIMITS): number {
  const url = new URL(`../../public/tutorial/${base}.${extension}`, import.meta.url);
  return statSync(fileURLToPath(url)).size;
}

describe("how-to media assets", () => {
  test("ships every source and poster within its byte budget", () => {
    for (const base of BASENAMES) {
      for (const extension of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
        const bytes = sizeOf(base, extension);
        expect(bytes, `${base}.${extension} is empty`).toBeGreaterThan(0);
        expect(bytes, `${base}.${extension} exceeds its budget`).toBeLessThanOrEqual(LIMITS[extension]);
      }
    }
  });

  test("keeps both video formats at or below 7.5 MB total", () => {
    const bytes = BASENAMES.reduce((total, base) =>
      total + sizeOf(base, "webm") + sizeOf(base, "mp4"), 0);
    expect(bytes).toBeLessThanOrEqual(7_500_000);
  });
});
```

- [ ] **Step 2: Run the asset test and verify it fails**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto-assets.test.ts
```

Expected: FAIL with `ENOENT` for `public/tutorial/drive.webm`.

- [ ] **Step 3: Add the deterministic encoding script**

Create `redline3d/scripts/encode-tutorial-media.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

RAW_DIR="${1:-}"
if [[ -z "$RAW_DIR" ]]; then
  echo "usage: $0 /absolute/path/to/raw-mov-directory" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/tutorial"
mkdir -p "$OUT"

FILTER="fps=24,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
NAMES=(drive lobby market-side leverage cash-out)

for NAME in "${NAMES[@]}"; do
  INPUT="$RAW_DIR/$NAME.mov"
  if [[ ! -f "$INPUT" ]]; then
    echo "missing raw capture: $INPUT" >&2
    exit 3
  fi

  DURATION="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$INPUT")"
  if ! awk -v duration="$DURATION" 'BEGIN { exit !(duration >= 5 && duration <= 8.2) }'; then
    echo "$NAME.mov must be between 5.0 and 8.2 seconds, got $DURATION" >&2
    exit 4
  fi

  ffmpeg -y -i "$INPUT" -an -vf "$FILTER" \
    -c:v libvpx-vp9 -b:v 420k -maxrate 500k -bufsize 1000k \
    -deadline good -cpu-used 2 -row-mt 1 "$OUT/$NAME.webm"

  ffmpeg -y -i "$INPUT" -an -vf "$FILTER" \
    -c:v libx264 -profile:v high -level 4.0 -b:v 640k -maxrate 700k -bufsize 1400k \
    -movflags +faststart "$OUT/$NAME.mp4"

  ffmpeg -y -ss 1 -i "$OUT/$NAME.webm" -frames:v 1 \
    -c:v libwebp -quality 82 "$OUT/$NAME.webp"
done
```

Make it executable:

```bash
chmod +x redline3d/scripts/encode-tutorial-media.sh
```

- [ ] **Step 4: Capture five real game recordings**

Run the real client at a 1280 by 720 browser viewport:

```bash
cd redline3d
npm run dev
```

Record only the game viewport, with no browser chrome, pointer, developer tools, debug overlays, account names, or wallet details. Save the raw files outside the repository with these exact names and scenes:

- `drive.mov`: hold acceleration, steer left, steer right, then return near center so the loop does not jump sharply.
- `lobby.mov`: drive through the live lobby with TRACK, GARAGE, UPGRADES, and CRATES readable during the same continuous pass.
- `market-side.mov`: show the real ticket changing Long to Short, set the play amount, return to the intended side, then tap `GO!`.
- `leverage.mov`: show the real leverage dial rising while the gas is held, then ease off before the clip ends.
- `cash-out.mov`: show the live multiplier and the real `CASH OUT` button, then tap it before a settlement/result modal covers the action.

Each raw file must be 5.0 to 8.2 seconds. Keep gameplay at normal speed. Do not add labels, transitions, audio, or editing effects to the raw captures.

- [ ] **Step 5: Encode all assets**

Run with the directory containing the five raw `.mov` files:

```bash
redline3d/scripts/encode-tutorial-media.sh /absolute/path/to/raw-mov-directory
```

Expected: `redline3d/public/tutorial/` contains 15 non-empty files, three for each basename.

- [ ] **Step 6: Validate encoding properties and byte budgets**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto-assets.test.ts
for file in public/tutorial/*.webm public/tutorial/*.mp4; do
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,r_frame_rate:format=duration \
    -of default=nw=1 "$file"
done
```

Expected: 2 asset tests pass. Every video reports `width=640`, `height=360`, `r_frame_rate=24/1`, and duration between 5.0 and 8.2 seconds. No audio stream is printed because the command selects video only; verify absence explicitly:

```bash
for file in public/tutorial/*.webm public/tutorial/*.mp4; do
  test -z "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$file")"
done
```

Expected: exit 0 with no output.

- [ ] **Step 7: Visually inspect every encoded loop and poster**

Open each WebM and MP4 in a browser and confirm:

- the demonstrated control and response are fully inside the 16:9 crop;
- text remains readable at the tutorial panel's 360-pixel content width;
- the first and last frames make a tolerable loop;
- the WebP poster shows the action clearly;
- no private or temporary information is visible.

Reject and recapture any clip that fails one of these checks, then rerun Steps 5 and 6.

- [ ] **Step 8: Commit the capture pipeline and production media**

```bash
git add redline3d/scripts/encode-tutorial-media.sh \
  redline3d/src/ui/howto-assets.test.ts \
  redline3d/public/tutorial
git commit -m "feat(tutorial): add real gameplay loops"
```

---

### Task 4: Verify the complete first-run and replay experience

**Files:**
- Verify: `redline3d/src/ui/howto.ts`
- Verify: `redline3d/src/ui/howto.test.ts`
- Verify: `redline3d/src/ui/howto-assets.test.ts`
- Verify: `redline3d/public/tutorial/*`
- Verify unchanged: `redline3d/src/main.ts`
- Verify unchanged: `redline3d/src/ui/carpicker.ts`

**Interfaces:**
- Consumes: all source, tests, and assets from Tasks 1 through 3.
- Produces: a tested build and a browser-verified five-card tutorial with intact first-run sequencing and hamburger replay.

- [ ] **Step 1: Run focused tutorial verification**

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts src/ui/howto-assets.test.ts
```

Expected: 12 tests pass.

- [ ] **Step 2: Run the complete automated suite**

```bash
cd redline3d
npm test
npm run build
```

Expected: the full Vitest suite passes; TypeScript and Vite build exit 0.

- [ ] **Step 3: Verify the desktop walkthrough from the menu**

Start the app and open `How to play` from the hamburger menu. Confirm in order:

1. The existing dark blurred overlay and cyan Perps Raider panel remain visually unchanged outside the new media area.
2. Card one plays the real drive loop and says `Take the wheel`.
3. Card two plays the real lobby loop and shows TRACK, GARAGE, UPGRADES, and CRATES with their approved colors and copy.
4. Card three shows Long, Short, play amount, and `GO!`.
5. Card four shows the real leverage dial responding to gas.
6. Card five shows the multiplier and `CASH OUT`, and its button says `LET'S GO`.
7. Back, Next, Skip, swipe, left/right arrow keys, and Escape retain their current behavior.
8. Closing and reopening from the hamburger resets to card one.

- [ ] **Step 4: Verify first-run sequencing**

Use a fresh browser profile with no Perps Raider site data. Complete the identity/access gate and confirm the exact order remains:

```text
identity/access gate -> five-card tutorial -> welcome crate -> lobby
```

Finish once through `LET'S GO`, reload, and confirm the tutorial does not auto-show again. Reopen it from the hamburger and confirm replay still works.

- [ ] **Step 5: Verify mobile, reduced motion, and failure states**

At a 390 by 844 viewport, confirm the panel fits, the media remains 16:9, lobby labels remain two columns, and navigation stays reachable.

Enable reduced motion in the browser/OS, reload, and confirm all five cards show WebP posters with no autoplay.

Block both video requests for one card while leaving its WebP available. Confirm the poster, title, copy, dots, Skip, and navigation remain usable. Then allow MP4 but block WebM and confirm the MP4 fallback plays.

- [ ] **Step 6: Confirm the change stayed in scope**

Run:

```bash
git diff HEAD~3 --name-only
```

Expected changed paths are limited to:

```text
redline3d/src/ui/howto.ts
redline3d/src/ui/howto.test.ts
redline3d/src/ui/howto-assets.test.ts
redline3d/scripts/encode-tutorial-media.sh
redline3d/public/tutorial/*
```

Confirm `redline3d/src/main.ts` and `redline3d/src/ui/carpicker.ts` are absent from the diff.
