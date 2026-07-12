# Perps Rider Landing Page Design

## Goal

Create a fast, single-page marketing experience at `/` that explains Perps Rider in the same synthwave arcade language as the game and sends players into the existing game at `/play/`.

## Product Positioning

The page leads with the line **“A real perp you drive.”** It explains the game in player language:

1. Pick long or short.
2. Rev to choose leverage.
3. Bank the position before liquidation becomes a wreck.

Practice play is free. Playing for real SOL requires sign-in and can lose the play amount.

## Visual Direction

Use the existing Perps Rider design system instead of introducing a marketing-site style:

- Near-black violet background with subtle stars, road perspective lines, and cyan/magenta glow.
- Chakra Petch for all display and interface text.
- Cyan `PERPS`, magenta `RIDER`, green launch actions, amber risk accents.
- Chamfered buttons, translucent HUD panels, thin neon borders, uppercase labels, and tabular statistics.
- The generated `public/loadingscreen.png` artwork is the hero poster. Existing tutorial posters provide gameplay detail below the fold.

The desktop hero is a two-column composition with copy on the left and the portrait poster on the right. Mobile collapses to one column and keeps the launch action visible near the top.

## Page Structure

1. **Navigation:** Perps Rider wordmark, `How it works`, `Built on`, and `Launch game`.
2. **Hero:** status eyebrow, positioning line, short explanation, primary launch CTA, secondary scroll CTA, live-chain proof chips, and the generated poster.
3. **How it works:** three cards for Call, Rev, and Bank using existing tutorial imagery.
4. **The strip:** four compact stops for Track, Garage, Upgrades, and Crates.
5. **Technology:** Pyth live prices, MagicBlock execution, and Solana settlement in concise player-facing language.
6. **Final CTA:** launch prompt plus the real-SOL risk note.
7. **Footer:** product name, devnet status, and a repeated game link.

## Routing and Platform Behavior

- `/` serves the marketing landing page.
- `/play/` serves the current Three.js game shell unchanged.
- Vite builds both pages as explicit HTML entries.
- The PWA manifest starts at `/play/`.
- Capacitor native builds briefly evaluate the landing entry and immediately replace the location with `/play/`, so the Android app continues to boot directly into the game.
- All public asset URLs remain root-relative so both HTML entries share the current asset pipeline.

## Code Boundaries

- `index.html`: semantic landing-page document and copy only.
- `play/index.html`: existing game shell, loading UI, and `/src/main.ts` entry.
- `src/landing/landing.css`: complete landing layout, responsive behavior, motion, and fallbacks.
- `src/landing/main.ts`: native redirect, menu behavior, asset fallback, and progressive reveal only.
- `src/landing/landing-shell.test.ts`: routing, copy, CTA, and build-entry contract.
- `vite.config.ts`: explicit multi-page inputs.
- `public/manifest.webmanifest`: installed-app start route.

The landing entry must not import Three.js, wallet adapters, or the game `main.ts` bundle.

## Accessibility and Resilience

- Semantic landmarks and a single `h1`.
- Keyboard-visible focus states and labelled navigation.
- Decorative imagery has empty alt text; tutorial imagery has useful alt text.
- `prefers-reduced-motion` disables reveal transitions, glows, and animated grid drift.
- If JavaScript fails, the landing page and `/play/` link remain usable.
- If the hero image fails, the poster frame retains a CSS gradient and the text hierarchy remains complete.
- Mobile layout has no horizontal overflow at 390 px.

## Verification

- Test the landing contract before implementation and observe the expected failure.
- Confirm both `dist/index.html` and `dist/play/index.html` are emitted.
- Run the landing contract test and the existing focused UI tests.
- Run `npm run build` in `redline3d`.
- Inspect `/` and `/play/` at desktop and mobile widths in the browser.
- Verify CTA navigation, poster fallback, reduced motion, and Android asset sync.

## Out of Scope

- No embedded Three.js scene on the landing page.
- No new wallet or sign-in flow.
- No analytics, mailing list, roadmap, token claims, or additional legal pages.
- No changes to game mechanics or on-chain programs.
