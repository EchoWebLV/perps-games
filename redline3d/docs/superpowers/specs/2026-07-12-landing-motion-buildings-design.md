# Landing Motion and Buildings Design

## Goal

Make the Perps Rider landing page feel alive and game-like by replacing static tutorial imagery with native video loops, turning the four Strip stops into recognizable buildings, and introducing an abstract dynamic background that extends the existing neon racing identity.

## Visual Direction

The selected direction is **Neon Freeway Mirage**. It combines slow plasma fields, perspective road grids, floating light trails, and sharp arcade architecture. Motion should feel energetic and unusual without competing with the copy or calls to action.

The background responds subtly to pointer movement on desktop and device orientation on supported mobile devices. Ambient animation continues without input. Content sections retain dark local contrast so text remains legible over the visual field.

## Tutorial Videos

The three How It Works cards use native `<video>` elements instead of static `<img>` elements.

Each video:

- autoplays, loops, remains muted, and uses `playsinline`;
- prefers the existing WebM asset and falls back to the existing MP4 asset;
- uses the existing WebP image as its poster and visual fallback;
- is decorative because the adjacent heading and paragraph describe the action;
- pauses or avoids autoplay when the user requests reduced motion.

No custom player controls or video library will be added.

## Strip Buildings

The four existing Strip stops remain a responsive four-item grid. Each card gains a lightweight HTML and CSS building illustration with a distinct silhouette and façade treatment:

1. **Track:** a race control tower with a starting-light motif.
2. **Garage:** a broad workshop with a glowing service bay.
3. **Upgrades:** a tuning lab with stacked energy coils or power bands.
4. **Crates:** a depot with offset cargo blocks and a lit loading door.

Labels and descriptions remain readable card content, not text baked into imagery. Building illustrations are decorative and hidden from accessibility APIs. On hover or focus, lighting and façade details intensify without moving the card enough to disrupt reading.

## Dynamic Background

The page receives one fixed decorative background container behind all landing content. It is composed of independent CSS layers:

- soft plasma blobs for large color movement;
- a perspective grid for the freeway reference;
- diagonal light streaks for speed;
- small depth particles for parallax;
- the existing scanline treatment as a final texture.

The landing script writes normalized pointer or tilt values to CSS custom properties on the root element. Updates are coalesced through `requestAnimationFrame`. CSS transforms each background layer by a different amount to create depth.

The implementation remains dependency-free and does not import Three.js or game code into the landing bundle.

## Accessibility and Fallbacks

- `prefers-reduced-motion: reduce` disables ambient background keyframes, input parallax, autoplay, and nonessential building motion.
- Background and building visuals use `aria-hidden="true"` because they convey no information that is absent from text.
- The existing WebP tutorial posters remain visible while video loads and when video playback fails.
- Pointer and device-orientation input are enhancements. The page remains complete when either API is unavailable or permission is denied.
- Foreground text, buttons, and navigation preserve their existing contrast and focus states.

## Component Boundaries

- `index.html` owns semantic markup for tutorial videos, the background container, and the four building illustrations.
- `landing.css` owns all visual rendering, animation, responsive behavior, and reduced-motion overrides.
- `landing/main.ts` owns menu behavior, reveal behavior, video motion preferences, and the small normalized pointer or tilt input adapter.
- `landing-shell.test.ts` verifies the landing contract without testing browser rendering details.

## Verification

Automated checks will verify:

- three tutorial videos each include WebM and MP4 sources, a poster, muted autoplay, looping, and inline playback;
- four distinct building hooks exist in the Strip section;
- the fixed background layer and interaction hooks exist;
- the landing entry remains free of Three.js and Capacitor dependencies;
- landing tests and the production build pass.

Visual verification will cover desktop and narrow mobile layouts, readable text over the most intense background state, video fallback posters, hover and focus states, and reduced-motion behavior.

## Out of Scope

- New tutorial recordings or media encoding.
- Canvas, WebGL, or shader-based background rendering.
- Changes to the game route or in-game Three.js building models.
- Audio on landing-page tutorial videos.
