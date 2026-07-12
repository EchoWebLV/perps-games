# Gameplay media tutorial redesign

**Date:** 2026-07-10

**Branch:** `intro-clarity`

**Status:** approved design

**Supersedes:** `2026-07-09-how-to-play-design.md`

## Decision

Replace the current six-card, emoji-led "How to Play" walkthrough with five concise cards built around short recordings of the real game. Keep the existing Perps Rider tutorial shell, controls, colors, typography, and first-run/menu triggers.

The recordings should behave like GIFs, but ship as muted looping video. Use WebM first with MP4 fallback for smaller downloads, smoother playback, and broad browser support.

## Goals

- Show each action instead of describing it abstractly.
- Make every card understandable in one viewing and one short sentence.
- Match the current Perps Rider UI exactly.
- Explain the four functional lobby buildings in one quick card.
- Keep the walkthrough short, skippable, replayable, and inexpensive to load.

## Non-goals

- No interactive coach-mark system over live gameplay.
- No changes to driving, round mechanics, leverage, settlement, upgrades, crates, or the lobby.
- No economy, wallet, sign-in, practice-mode, or custody explainer in this walkthrough.
- No new tutorial framework beyond the existing `ui/howto.ts` overlay.

## Experience

### Visual shell

Keep the current overlay and panel as the source of truth:

- dark blurred backdrop over the live game;
- `Chakra Petch` typography;
- dark violet panel with the existing cyan border and glow;
- `SKIP` in the top-right corner;
- progress dots, back arrow, green `NEXT` button, swipe, arrow keys, and Escape behavior;
- responsive width of `min(400px, 94vw)` with the current rounded corners and spacing.

Replace the large emoji with a rounded 16:9 media window at the top of the panel. The window uses the same cyan border treatment as the panel. Reduce the body copy area because each card now has one short sentence.

### Card sequence

1. **Take the wheel**
   - Clip: the real player car accelerates and steers left, then right.
   - Copy: "Hold to drive. Drag left or right to steer."

2. **Know the strip**
   - Clip: the player drives through the real lobby while the four functional buildings come into view.
   - Four compact labels remain visible below the clip:
     - **TRACK:** start a price race
     - **GARAGE:** choose your car
     - **UPGRADES:** increase risk and time
     - **CRATES:** unlock new cars
   - Use the existing building colors: Track `#14f195`, Garage `#27e7ff`, Upgrades `#ffd166`, and Crates `#ff39c0`.

3. **Call the market**
   - Clip: select Long, select Short, set the play amount, then tap `GO!`.
   - Copy: "Long if price goes up. Short if it goes down. Then tap GO."

4. **Choose your risk**
   - Clip: hold the gas while the real leverage dial climbs.
   - Copy: "More revs means more leverage. Bigger wins, faster wrecks."

5. **Bank it before you wreck**
   - Clip: the live multiplier rises, then the player taps `CASH OUT`. End before any result modal obscures the action.
   - Copy: "Cash out to keep the win. Hit liquidation and lose the play amount."
   - The final primary button reads `LET'S GO`.

### Trigger and replay

Preserve current behavior:

- Show once after the identity/access gate and before the welcome crate.
- Mark the tutorial as seen only when it closes through Skip, Escape, or the final button.
- Keep the hamburger menu's `How to play` entry as the replay path.
- Opening from the menu always starts at card one.

## Media production

Capture the clips from the actual game at the same visual quality used in the shipped client. Do not recreate gameplay with illustration or animation.

Each clip should:

- run for 5 to 8 seconds;
- loop without an obvious jump;
- use a 16:9 frame at 640 by 360 or smaller;
- use 24 frames per second unless motion quality requires 30;
- contain no audio track;
- avoid account names, wallet details, debug UI, or temporary development copy;
- keep the demonstrated control and its response unobscured;
- target no more than 600 KB per WebM and 900 KB per MP4.

Store the production assets under `redline3d/public/tutorial/` with stable names:

- `drive.webm` and `drive.mp4`
- `lobby.webm` and `lobby.mp4`
- `market-side.webm` and `market-side.mp4`
- `leverage.webm` and `leverage.mp4`
- `cash-out.webm` and `cash-out.mp4`

Generate one WebP poster per clip from its clearest frame, using the same basename as the video, such as `drive.webp` and `cash-out.webp`. Posters provide an immediate visual while video loads and become the reduced-motion presentation.

## Loading and playback

The media window is a `<video>` with `muted`, `loop`, `playsinline`, and autoplay enabled. WebM is the first source and MP4 is the fallback.

- Load the current card's video immediately.
- Preload metadata for the next card only.
- Pause a video as soon as its card is no longer visible.
- Restart the next card from the beginning when it becomes active.
- If autoplay is blocked, keep the poster visible and show a small play affordance.
- If both video formats fail, keep the poster and all copy/navigation functional.
- Under `prefers-reduced-motion: reduce`, show posters only and do not autoplay.

The walkthrough must remain usable before any media finishes loading.

## Component boundary

Keep tutorial behavior within `redline3d/src/ui/howto.ts`:

- card metadata owns title, copy, media filenames, poster filename, and optional lobby labels;
- a small media renderer owns video creation, source fallback, play/pause, and poster fallback;
- the existing overlay owns paging, navigation, keyboard controls, swipe, close callbacks, and the durable seen flag.

Do not thread tutorial media state into `main.ts`. `main.ts` continues to create and trigger the overlay exactly as it does today.

## Verification

### Automated

- Existing seen-flag tests remain green.
- Add DOM tests for five cards, five progress dots, stable card order, and final-button copy.
- Test that advancing pauses the previous video and activates the new video.
- Test video-error fallback to the poster without blocking navigation.
- Test reduced-motion mode renders posters without autoplay.
- Run TypeScript, the focused tutorial tests, and the full test suite.

### Visual and interaction

- Verify desktop and narrow mobile layouts against the existing Perps Rider panel.
- Verify all five real clips are legible, loop cleanly, and match their copy.
- Verify the four lobby building labels use the real building colors.
- Verify Skip, back, next, swipe, arrow keys, Escape, and menu replay.
- Verify first-run ordering still reaches the welcome crate after closing the tutorial.
- Verify a slow or failed media request never traps the player.

## Success criteria

- A new player can identify driving, the four lobby destinations, Long versus Short, leverage, and Cash Out by watching rather than decoding a paragraph.
- No card contains more than one primary lesson.
- The redesign reads as the existing Perps Rider UI, not a separate onboarding product.
- The full tutorial media payload stays below 7.5 MB across both source formats, excluding posters.
