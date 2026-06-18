# Redline 3D (Seeker-ready) — Design Spec

**Date:** 2026-06-18
**Status:** Draft for review
**Author:** Brainstormed with Claude
**Supersedes (renderer only):** the 2D `canvas` prototype in `prototype/redline.html`

---

## 1. One-liner

Rebuild **Redline** — the arcade game that rides the live SOL price (pick long/short, dial leverage, cash out before the redline wrecks you) — as a **true 3D, neon-synthwave driving game** that *feels* fast and high-stakes, from **one codebase that ships both a web PWA and a Seeker Android APK**. Keep the working game core (live Pyth feed, LINEAR-from-entry economics, round state machine); rebuild only the renderer, HUD, and platform layer.

## 2. Goals & non-goals

### Goals
1. A genuinely higher-fidelity, better-*feeling* 3D version of Redline — quality and game-feel, not just new graphics.
2. **Risk made physical:** leverage and being-in-the-money drive speed, camera, audio, and haptics, so high leverage is viscerally felt.
3. **One codebase → two targets:** an installable web PWA and a Capacitor-wrapped Android APK that is clean and listable on the Solana dApp Store.
4. **Seeker-ready, wired later:** Mobile Wallet Adapter and dApp-Store packaging are designed-in behind interfaces; not fully wired this pass.
5. **Performance-first:** 60fps target on mid/upper Android with a graceful 30fps fallback; small bundle; thermal/battery aware.
6. Preserve the solved economics (the vol-fragility fix) untouched by keeping the core headless and pure.

### Non-goals (this pass)
- Real money, USDC custody, the vault, or the provably-real resolver — those stay on the separate **Minefield/Yoichi spec track**. This build keeps the **local simulated balance** ($100 play money).
- Fully wiring real Mobile Wallet Adapter / Seed Vault (interface only this pass).
- Publishing to the Solana dApp Store (build stays publish-clean; submission is later).
- A second game (Yoichi/Minefield in 3D) — shared foundations are welcome but out of scope here.
- Native (non-web) rendering engines (Unity/native) — rejected; see §4.

## 3. Scope decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| Game | **Redline** (car/road) |
| Platform scope | **Seeker-ready web 3D** (mobile-first WebGL; wallet/packaging designed-in, wired later) |
| Reuse | **Evolve core, rebuild shell** — keep feed + economics + round logic; rebuild renderer + HUD |
| Output | **Parallel web PWA + Android APK** from one codebase |
| Art direction | **A · Neon synthwave** (evolve today's look into true 3D), with **B's performance discipline** (stylized-clean geometry, 60fps-first) |
| Stack | **Three.js (WebGL2) + Vite + Capacitor** |

## 4. Approach & rationale

Chosen stack: **vanilla Three.js + Vite, wrapped to Android with Capacitor.**

- **Vanilla Three.js (not R3F):** smallest/fastest bundle (matters most on a phone), full control of the synthwave shaders, and the plain-JS game core ports in with minimal friction. R3F's declarative scene graph and ecosystem are nice but add React runtime/bundle weight and a larger HUD rewrite for little gain on a single-screen arcade game.
- **Vite:** instant HMR preserves the fast-iteration workflow the prototype enjoyed; standard PWA build.
- **Capacitor (not TWA, not Unity):** wraps the *same* web build into a native Android APK, bridges native MWA/Haptics, and keeps one codebase for web + APK. Unity was rejected because it discards the JS core, ships a heavy WebGL bundle (slow mobile first-load), and iterates slowly.

## 5. Architecture & module boundaries

Guiding principle — **"evolve core, rebuild shell" made literal:** the game *core* is a **headless, pure-logic layer** (zero DOM/WebGL/Three dependencies), so it is the exact logic already trusted, now unit-testable in isolation. Everything visual/platform-specific is the rebuilt shell around it.

```
redline3d/
  index.html · vite.config.ts · capacitor.config.ts · package.json
  public/                 icons, web manifest, (optional tiny audio samples)
  src/
    core/                 ← KEPT (ported ~verbatim, headless & pure)
      feed.ts             Pyth Lazer→Hermes→sim client (today's feed.js)
      economics.ts        LINEAR-from-entry equity, banked, leverage, caps
      round.ts            FSM: idle→launched→(settled | liquidated)
      config.ts           EDGE, LIQ, CAP, MAXSEC, leverage range
    render/               ← REBUILT (Three.js)
      scene.ts world.ts car.ts camera.ts post.ts fx.ts
    ui/                   ← REBUILT (DOM overlay over the canvas)
      hud.ts tach.ts controls.ts intro.ts
    platform/             ← NEW (isolates web vs Seeker behind interfaces)
      haptics.ts          Capacitor Haptics / web vibrate
      wallet.ts           Mobile Wallet Adapter — interface now, wired later
      perf.ts             device-tier detection + quality scaler
    main.ts               bootstrap: wires core → render → ui → platform
  android/                Capacitor-generated native project
```

### Module contracts
- **`core/`** emits plain state/events (`onTick`, `equity`, `multiplier`, `onSettle`, `onLiquidate`) and knows nothing about a renderer. This is what keeps the solved economics safe — we don't touch the vol-fragility fix.
- **`render/`** subscribes to core state and draws; swappable without touching game logic.
- **`ui/`** is a DOM overlay above the WebGL canvas (HUD, tach, controls, intro) — keeps text crisp and accessible, and reuses today's HUD CSS patterns/safe-area handling.
- **`platform/`** hides every web-vs-APK-vs-Seeker difference behind small interfaces, so `core`/`render` never branch on platform (`if (isNative)` lives only here).
- **`main.ts`** is the only place the layers meet.

## 6. The 3D experience (quality + feeling)

Core idea: **every visual is driven by the game's risk state**, so leverage and being-in-the-money are *felt*, not just read.

### World (synthwave, performance-first / low-poly)
- **Infinite recycling road** — segmented mesh scrolling toward a chase camera; dark wet material with emissive lane lines + a faint reflected sun.
- **Neon grid floor** to the horizon (animated shader plane, distance-fogged).
- **Sky dome** with the **sliced retro sun** (emissive), low-poly mountain silhouettes, parallax stars.
- **Roadside props** (neon pylons / palms / billboards) whipping past for speed sensation — GPU-instanced and recycled. Fog hides the recycle seam and caps draw distance.

### Car
Procedural low-poly (no heavy model), emissive neon rim + underglow, rear-3/4 chase view. Squats under acceleration, idle-wobbles, and keeps today's **green/red equity color** semantic.

### Camera = the main feel lever
Speed rises with **leverage × how-far-in-the-money** → camera pulls back, **FOV widens**, speed-streaks intensify; so high leverage is physically overwhelming. Subtle bob normally, **building to a shake at the redline** (near liquidation).

### Cinematics in true 3D (keep existing trigger logic)
- **Fly-off** (survive / cash-out / time-cap): car lifts off, rockets skyward with a 3D exhaust plume; camera tilts up to follow it to the sun; coins burst. **Green** if profit, **gold** if flat/loss.
- **Explosion** (liquidation): car bursts into tumbling **3D debris chunks** (instanced), fireball billboards + bloom, an expanding **shockwave ring**, hard shake + flash. Debris *is* the car (mesh hidden), as today.

### Audio + haptics (new — major feel upgrade)
- **Audio (WebAudio):** engine drone pitched by leverage/speed, synthwave bed, cash-out chime, redline warning, explosion boom. Procedural-first; a few tiny samples allowed in `public/`.
- **Haptics:** tick on leverage change, rising rumble near liquidation, sharp jolt on blow-up, soft pop on cash-out — routed through `platform/haptics` (Capacitor Haptics on APK, `navigator.vibrate` on web).

### Post-processing (perf-gated by `perf.ts`)
UnrealBloom for neon glow + vignette; chromatic aberration only on high-tier. Bloom at half-res, DPR capped ~2, particle/prop counts scale by tier, 60fps target with a 30fps fallback.

## 7. Seeker / mobile readiness

**Scope boundary:** this is the **game client**. It keeps today's local **simulated balance** ($100). Real USDC, vault, and resolver stay on the Minefield track. `platform/wallet.ts` is a thin interface (`connect`, `signMessage`, `signAndSendTransaction`) with a **sim implementation now**, swappable for a real MWA impl later with no `core`/`render` changes.

### Two targets, one build
- **Web PWA** — installable, offline app-shell, `manifest.json`, fullscreen, **portrait-locked**, safe-area insets (carried from today's `env()` CSS). Runs in the Seeker browser today.
- **Android APK** — Capacitor wraps the same Vite build: `cap add android` → `cap sync` → signed APK. Immersive fullscreen, splash, icon, status-bar styling. Kept **dApp-Store-listable** for a later publish.

### Mobile Wallet Adapter (designed-in)
`@solana-mobile/mobile-wallet-adapter-protocol` on the APK behind `wallet.ts`; returns a sim wallet today, connects the Seeker's Seed Vault later. No `core`/`render` changes to flip it on.

### Performance budget (Seeker = mid/upper Android)
60fps target, **30fps graceful fallback**. `perf.ts` detects a device tier (GPU string + DPR + a short frame-time probe) and scales: **DPR capped ~2**, bloom on/half-res vs off, **no real-time shadows** (baked/fake only), instanced prop density, particle budget, post-fx chain. Thermal/battery: fog-limited draw distance, single light, minimal overdraw, and **pause the render loop when backgrounded** (Capacitor `appStateChange` / web visibility).

### Input
One-thumb touch — long/short toggle, stake ±, tach-drag leverage, big LAUNCH / CASH-OUT button. Pinch/double-tap zoom and pull-to-refresh disabled; safe-area aware. Optional gated **device-tilt parallax** as flavor.

## 8. Asset strategy — procedural-first

No heavy external models/textures: car from primitives/extrusions, world from shaders + instanced primitives, sun/grid/sky as shaders, particles as GPU points/sprites. Audio is procedural WebAudio (or a few tiny compressed samples in `public/`). Result: a small bundle (Three.js + a few hundred KB), **no external/CDN asset dependence** — fast first load, fully offline-capable (good for PWA + dApp-Store APK), instant iteration. HUD keeps today's system rounded font.

## 9. Error handling & edge cases

- **Feed gap/stale mid-run:** reuse the hardened Lazer→Hermes→sim fallback; **freeze price** + show a "feed stalled" indicator; never settle P&L on stale ticks; resume on recovery.
- **WebGL context loss** (mobile GPU reset/backgrounding): listen for `webglcontextlost/restored`, pause, rebuild scene on restore.
- **Backgrounding mid-run:** **pause both render and the round clock** while hidden, so the player is never liquidated with the app closed (also sidesteps the frozen-loop quirk seen in the prototype).
- **Low-end / no WebGL2:** auto-drop to minimal quality; graceful message if no WebGL at all.
- **Accessibility:** honor `prefers-reduced-motion` (tone down shake/streaks); auto-step quality down on sustained frame drops.

## 10. Testing & verification

- **`core/` is pure → Vitest unit tests:** economics (LINEAR-from-entry equity across leverage/price moves; `banked`; caps `EDGE/LIQ/CAP/MAXSEC`), round FSM transitions, feed parsing/fallback with mocked streams.
- **Recorded-tick replay regression guard:** a captured tick sequence → asserts equity/settle/liquidate outcomes, protecting the solved vol-fragility economics against regressions.
- **`render`/`ui`:** manual visual verification via the preview workflow (screenshots, zero-console-errors, scene-builds, FPS probe) — not unit-tested.
- **APK + cross-target smoke test** when Capacitor is added (same build runs as web PWA and inside Capacitor).

## 11. Phasing (each phase shippable/visible)

- **Phase 0 — Foundation:** Vite scaffold; port `core/` (feed, economics, round, config) headless; unit tests green. Proves the core runs detached from any renderer.
- **Phase 1 — Playable 3D:** scene/world/car/camera + HUD/controls wired to core; basic bloom; the synthwave look; one device tier. The "it's 3D and it plays" milestone.
- **Phase 2 — Feel:** 3D fly/explode cinematics, audio, haptics, risk-driven camera/FOV/shake, perf tiering + fallback.
- **Phase 3 — Seeker packaging:** Capacitor APK, PWA manifest/offline, portrait lock, wallet-interface stub, dApp-Store-clean build.
- **Deferred (other track):** real MWA / Seed-Vault wiring, real USDC / vault / resolver (Minefield spec), dApp-Store publish.

## 12. Open questions / risks (ranked)

1. **Sustained 60fps with bloom on real mid-tier Android** — the central perf risk; mitigated by the tier scaler + half-res bloom + 30fps fallback, validated on-device in Phase 2.
2. **Capacitor + Mobile Wallet Adapter bridging** ergonomics on the Seeker — de-risked by keeping `wallet.ts` an interface (sim now), but the real wiring needs a spike before relying on it.
3. **Game-feel tuning of risk→speed/FOV/shake mapping** — the difference between "fun" and "nauseating"; needs iteration with `prefers-reduced-motion` respected.
4. **Thermal throttling over long sessions** — pause-on-background + DPR cap help; watch for heat-induced downclock on the Seeker specifically.
5. **Port fidelity of the economics** — the replay regression guard must be built early (Phase 0) to guarantee the new core matches the trusted prototype behavior.

## 13. Key references

- `prototype/redline.html` — the 2D prototype being evolved (game core, HUD, cinematics to preserve).
- `prototype/feed.js` — the hardened Pyth Lazer→Hermes→sim client to port into `core/feed.ts`.
- Memory: `redline-economics` (LINEAR-from-entry P&L, vol-fragility fix — must not regress), `redline-novelty-real-perp` (protect the real-perp-on-a-live-feed core), `pyth-lazer-feed` (feed endpoints/fallback).
- Three.js (WebGL2), `postprocessing` / `UnrealBloomPass`; Vite; Capacitor (Android); `@solana-mobile/mobile-wallet-adapter-protocol`; Capacitor Haptics.
