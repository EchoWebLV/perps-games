# Strip Building Renders Design

## Goal

Replace the rejected CSS line-art buildings on the landing page with polished isometric renders of the actual Perps Rider Three.js building models.

## Selected Direction

Use the existing Track, Garage, Upgrades, and Crates model builders as the single visual source of truth. Render each building from the same isometric camera with studio lighting, a transparent background, a soft contact shadow, and its existing neon accent color.

The result should look like a game asset, not a diagram or icon. Each render must preserve the recognizable details already present in the in-game model, including the Track gate and grandstand, the Garage bay and parked car, the Upgrades ziggurat and arrow, and the Crates yard and gantry crane.

## Render Pipeline

Add a dedicated browser render page that imports the existing building constructors. It accepts a building name through the query string, creates only that model, applies its animation at a fixed timestamp, and frames it with a consistent orthographic camera.

A Puppeteer capture script starts a local Vite server, visits the render page once per building, waits for an explicit ready signal, and captures the transparent canvas as a WebP asset.

Output assets:

- `public/assets/landing/building-track.webp`
- `public/assets/landing/building-garage.webp`
- `public/assets/landing/building-upgrades.webp`
- `public/assets/landing/building-crates.webp`

The render page and capture script remain in the repository so the assets can be regenerated when the in-game models change. The landing bundle does not import Three.js.

## Rendering Style

- Use a three-quarter isometric camera angle with consistent perspective and visual scale.
- Use a dark violet key light, a cool cyan rim light, and the model's own emissive materials.
- Use a transparent world background.
- Add a soft elliptical contact shadow beneath the building without adding an opaque floor.
- Frame each model tightly while leaving enough transparent padding for glow and shadow.
- Render at high resolution so the images remain crisp on retina displays.
- Capture animations at a deliberate fixed timestamp that exposes useful detail rather than an arbitrary initial frame.

## Landing Layout

Each Strip card contains one real `<img>` with its building-specific WebP source and an empty alt attribute because the adjacent heading names the destination. The image occupies most of the card width and sits above the unchanged label and description.

Remove the nested CSS geometry elements and all selectors that draw the rejected line-art buildings. Keep only layout, hover lift, contact glow, and responsive sizing styles. Desktop remains a four-card row. Narrow layouts remain one card per row with a larger, centered building render.

## Accessibility and Performance

- Building images use `alt=""` and remain decorative.
- Images use explicit width and height attributes to avoid layout shift.
- Images use lazy loading and asynchronous decoding.
- WebP assets are committed, so visitors do not load Three.js or run the renderer.
- Reduced-motion disables hover lift but does not hide or degrade the static renders.

## Verification

Automated checks verify that all four cards use the expected WebP assets, include intrinsic dimensions, retain their existing labels, and do not contain the previous `.building-shell` geometry.

The render pipeline is verified by regenerating all four non-empty assets. Visual QA covers transparent backgrounds, consistent camera scale, readable silhouettes, visible model-specific details, desktop alignment, mobile stacking, and zero horizontal overflow.

## Out of Scope

- Redesigning the in-game building models.
- Adding live Three.js canvases to the landing page.
- Generating concept art that differs from the game world.
- Changing the tutorial videos or dynamic page background.
