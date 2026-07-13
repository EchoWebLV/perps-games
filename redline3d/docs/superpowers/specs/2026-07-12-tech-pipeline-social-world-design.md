# Technology Pipeline and Social World Design

## Goal

Turn the Under the Hood section into a four-stage animated story that explains how Perps Rider moves from market data to execution, settlement, and a shared social open world.

## Narrative

The four cards form one pipeline:

1. **PRICE / Pyth Lazer:** live prices enter the game.
2. **EXECUTION / MagicBlock:** the price-driven action becomes a fast on-chain round.
3. **SETTLEMENT / Solana:** the signed result settles into the player's wallet.
4. **WORLD / Social Open World:** the completed action returns the player to a shared place with other drivers.

The first three descriptions stay unchanged. The fourth card uses:

- Label: `WORLD`
- Heading: `Social Open World`
- Description: `Drive the Strip with other traders, show off your garage, and enter shared destinations together.`

## Animated Mini-Scenes

Each card receives one decorative inline SVG scene above its text. The scenes use the card's accent color and a shared visual language of dark panels, neon traces, moving pulses, and small status labels.

### Pyth Lazer

A cyan scanning beam crosses a sparkline. Price nodes ignite as the beam passes, and compact BTC, ETH, and SOL ticker values flicker at the edge. The scene communicates continuous market input rather than a static chart.

### MagicBlock

A price pulse enters layered transaction blocks. The layers compress into an Ephemeral Rollup core, accelerate through a short tunnel, and produce an execution confirmation flash. The animation communicates speed and batching.

### Solana

The executed packet enters orbital signature rings around a wallet card. The rings align, a signed trace completes, and a green settlement seal locks into place. The animation communicates authorization and finality.

### Social Open World

The settlement pulse expands into a miniature city grid. Driver nodes appear, neon cars move between Track, Garage, Upgrades, and Crates destinations, and small presence or emote pings ripple across the map. The animation communicates that the game is a shared place, not only a trade screen.

## Connected Flow

Desktop cards sit in a four-column row. A faint connector line runs behind them, and one pulse travels from Price through World. Each local scene loops independently, but animation delays make the four cards feel sequential rather than synchronized.

Tablet layouts use a two-by-two grid. Mobile layouts use one card per row and hide the long cross-card connector while retaining each local scene.

## Motion Architecture

The animation remains dependency-free. `index.html` owns semantic card content and decorative inline SVG markup. `landing.css` owns rendering, transitions, and keyframes. `landing/main.ts` owns visibility, user motion preference, and media playback state.

SVG motion uses transforms and opacity wherever possible. Small SVG strokes may pulse, but the large fixed background must stop animating gradient `background-position`. Ambient background movement and input parallax use separate nested layers so both can be compositor-driven without transform conflicts.

Technology scenes run only while the section intersects the viewport. Tutorial videos play only while their section is visible. When the document is hidden, all optional motion pauses.

## Motion Control and Accessibility

A visible `MOTION ON` / `MOTION OFF` button appears in the site header. It uses `aria-pressed`, remains keyboard accessible, and stores the user's choice in `sessionStorage`.

One root state controls tutorial videos, the abstract background, card scenes, and hover motion. The system follows these rules:

- `prefers-reduced-motion: reduce` pauses optional motion immediately.
- The media-query `change` event updates the page without requiring a reload.
- A user may turn motion off even when the operating system allows motion.
- Operating-system reduced motion always wins over the user toggle.
- Paused scenes retain a meaningful composed frame rather than disappearing.
- The toggle text and pressed state always describe the actual motion state.

## Existing Review Remediation

This change also resolves the final branch review findings:

- provide a visible global motion pause control;
- react live to reduced-motion changes;
- play tutorial videos only while visible;
- replace large fixed `background-position` animation with compositor-friendly transforms and avoid permanent `will-change` outside active motion;
- validate committed building assets for existence, WebP format, 1024 by 720 dimensions, and alpha in automated tests;
- keep normalized pointer input in TypeScript and move depth scaling back into CSS;
- remove the stale focus-animation requirement for noninteractive Strip cards rather than adding decorative tab stops.

## Testing and Verification

Contract tests verify four technology cards, all four scene hooks, exact Social Open World copy, the global motion control, visibility observers, live reduced-motion handling, session persistence, and production landing dependency isolation.

Building renderer tests inspect each committed WebP file rather than only capture-script source. They verify the RIFF/WebP signature, extended WebP metadata, 1024 by 720 dimensions, and alpha flag.

Visual verification covers desktop, tablet, and 390px mobile layouts; pipeline order; scene legibility; connector behavior; active and paused states; live reduced-motion changes; tutorial visibility playback; zero horizontal overflow; browser console errors; and mobile animation performance.

## Out of Scope

- Official third-party logos or externally hosted assets.
- Live network data in the landing illustrations.
- Three.js, canvas, or video inside the technology cards.
- Interactive technology cards or decorative keyboard focus targets.
- Spinning building assets.
