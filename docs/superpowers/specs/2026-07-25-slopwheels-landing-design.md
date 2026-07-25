# Slopwheels landing page rebrand — design

2026-07-25. Approved via brainstorm Q&A. Reworks the marketing landing page
(`redline3d/index.html` + `src/landing/*`) from the Perps Rider perps pitch to the
Slopwheels gacha/betting product the game now boots into.

## Decisions (user-approved)

- **Positioning = gacha-first.** Headline sells "pull crates, collect slop cars, bet on
  their races." Perps mode appears as **one feature section**, not the hook.
- **Approach = rebrand + rewrite inside the existing skeleton.** Keep the page structure
  (hero → how-it-works steps → strip → tech → CTA), the motion background system, the
  fonts, and the test suite. Swap brand, copy, art, and section themes.
- Prior spec's out-of-scope note ("full rebrand sweep: landing page…") is what this
  design now executes — for the landing surface only.

## 1. Brand shell

- **Wordmark:** header + footer replace the `<span>PERPS</span><strong>RIDER</strong>`
  text wordmark with `<img>` using `/assets/brands/slopwheels-alpha.png` (the glow-free
  alpha asset already in repo). Sized by height to match the current wordmark footprint;
  alt "Slopwheels".
- **Brand accent:** add `--brand` to the landing `:root` tokens, sampled from the
  wordmark's dominant green (≈`#c0f030`; workers sample the exact value from the PNG).
  CTAs (`.launch-button`, `.nav-launch`), the hero live-dot, and section eyebrows move to
  `--brand`. The existing cyan/magenta/amber accents stay for step cards and art. Page
  background/tokens otherwise unchanged.
- **Metadata:** `<title>` = "Slopwheels | Crack crates. Bet the race." Meta description,
  `og:title`, `og:description`, `apple-mobile-web-app-title` rewritten to the gacha
  pitch. `og:image` points at the new hero capture (see Media).
- **Manifest:** `manifest.webmanifest` name/short_name = "Slopwheels", description
  updated. Colors unchanged (`#05030d`).
- **Icons:** regenerate `icon-192.png` / `icon-512.png` programmatically — black
  rounded-square background, wordmark centered at ~80% width; `icon.svg` becomes a black
  rounded square with the wordmark embedded (data URI). No hand art.
- **Untouched:** `/downloads/perps-rider.apk` href and "Seeker APK" label (deploy-
  coupled), Chakra Petch font, motion background, domain, `/loadingscreen.png` asset
  itself (other surfaces may still reference it; the landing simply stops using it).

## 2. Content rewrite (same skeleton)

Copy numbers verified against code 2026-07-25: `CAR_DEFS` (`src/main.ts`) defines 24
cars of which 20 are currently pullable (`pool: false` benches 4), across rarity tiers
1–5; three crate tiers (Wooden/Silver/Gold, `src/core/crate.ts`); rake 5%, owner podium
share 40% of rake split 50/30/20 (`src/core/race-payout.ts`). Copy says "20+ cars · 5
rarity tiers" (honest: pullable today, more benched/coming). The leverage claim in the
perps section reuses the figures currently on the page ("10× to 3000×") verbatim — do
not invent new numbers.

- **Hero.** Eyebrow: "Gacha racing arcade on Solana devnet" (keep live-dot). H1: "Crack
  a crate. Bet the race." Lede: pull crates for a garage of ridiculous cars across five
  rarity tiers, send them into chaotic grand-prix races, and bet the pari-mutuel pool —
  when your car podiums, you take a cut of the house rake. Actions: Launch game (brand
  green), Seeker APK, "See how it works". Play-note: practice free / sign in for real
  pulls. Proof row: CARS 20+ · RARITY TIERS 5 · PODIUM PAYS OWNERS. Hero
  poster: new toon grand-prix capture (see Media) with updated figcaption ("BET THE
  RACE" / status line themed to the race, not the price feed).
- **Section 01 — How it works.** Heading: three moves, one race. Steps become:
  - `01 / PULL` — Crack crates. Every pull is a VRF roll; five rarity tiers, dupes melt
    to scrap.
  - `02 / BET` — Send your car to the grid (or just watch) and bet the pari-mutuel pool
    against seven rivals.
  - `03 / WIN` — Pool settles to the cent. Winning bets get paid; top-3 finishers' owners
    split a slice of the rake.
  Step media are still `.webp` captures (crate reveal, bet panel over the grid,
  settlement/podium) — the `<video>` markup slots stay but ship with stills; raw clips
  can be recorded and encoded later via the existing script pattern.
- **Section 02 — The strip.** Keeps the four building cards and art. Copy touch-ups
  only: TRACK "Send a car to the grand prix", GARAGE/CRATES/UPGRADES copy checked
  against current game truth (crates = where pulls happen).
- **NEW compact section — Mode 2: The Highway (perps feature card).** One section
  between strip and tech: "There's a real perp under the hood." Copy: pick a market,
  rev leverage (existing figures), bank before liquidation — the original Perps Rider
  mode lives inside Slopwheels via lobby buildings. Media: reuse the existing
  `/tutorial/leverage.*` (and optionally `cash-out`) video assets — they remain accurate
  for this mode. The Pyth price-feed scene (currently tech card 01) moves here as the
  section's visual flavor, or is dropped if the video carries it — worker's choice, but
  Pyth attribution must survive somewhere in this section.
- **Section 03 — Under the hood.** Four tech cards rethemed:
  1. PULLS / MagicBlock VRF — provably fair crate rolls (reuse the existing MagicBlock
     rollup scene + logo; status line "EPHEMERAL VRF / PROVABLY FAIR").
  2. RACES / Pari-mutuel engine — pool betting settled to the cent, house rake shared
     with podium owners (one new small SVG scene: odds/tote board in the existing scene
     style).
  3. SETTLEMENT / Solana — unchanged card.
  4. WORLD / Social open world — unchanged card.
- **Final CTA.** Eyebrow "The grid is forming", H2 themed to pulling/betting, button
  "Launch Slopwheels". Risk note stays verbatim ("REAL SOL INVOLVES REAL RISK…").
- **Footer.** Wordmark image; tagline updated ("Built for the slop. Running on Solana
  devnet."); links unchanged.
- **Nav.** Anchors keep working: How it works / The strip / Mode 2 (new anchor) /
  Built on / Launch game.

## 3. Media plan

All new raster assets live under `public/assets/landing/`:

- **Hero poster + OG image:** high-res screenshot of the toon grand-prix from the dev
  harness (`race-preview.html`, post blob-fix look), cropped/framed like the current
  poster. OG variant sized ~1200×630.
- **Step stills:** three 640×360 `.webp` captures matching the step topics — crate
  reveal (Store tab), bet panel over the race grid (market phase), settlement/podium
  overlay. Captured from the running app at a clean viewport, encoded at the tutorial
  pipeline's quality (`cwebp -q 82`).
- **Icons:** generated programmatically from `slopwheels-alpha.png` (script or one-off,
  workers' choice; result committed).
- Building `.webp` art and existing tutorial videos stay as-is on disk.

## 4. Testing & verification

- Update `src/landing/landing-shell.test.ts` / `main.test.ts` expectations to the new
  content (wordmark img, new section ids, step labels, manifest name). `motion-state`
  and `building-renderer` untouched unless section renames require it.
- `npx vitest run` and `tsc --noEmit` green; `npm run build` clean.
- Live browser proof (standing rule): landing loads with zero console errors at desktop
  and 375×812 — wordmark renders, nav anchors scroll, step stills load, perps section
  video plays, CTA links to `/play/`. Screenshot shared as proof.

## Out of scope

README/docs rebrand; domain change; renaming the APK file; any change under `/play/`
or the game itself; recording new video clips; deploying.
