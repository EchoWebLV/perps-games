# Branded Technology Scenes Design

## Goal

Replace the generic technology-card line animations with a stronger four-stage cinematic sequence. MagicBlock and Solana must be immediately recognizable through their canonical logos, while Price and Social Open World receive equally deliberate visual storytelling.

## Direction

Use stable, undistorted brand marks as visual anchors. Motion happens in the systems around each mark: data enters, compresses, settles, and expands into a shared world. The four cards should read as one pipeline even when viewed individually.

## Brand Assets

- Store local SVG copies under `public/assets/brands` so the landing page has no runtime dependency on external hosts.
- Source the MagicBlock horizontal white logo from the official MagicBlock website asset at `https://cdn.prod.website-files.com/67dd3f471f62a240dd544dd8/682efe2b89d00ecb838fa333_Frame%2085.svg`.
- Source the Solana mark from the official Solana brand kit at `https://solana.com/src/img/branding/solanaLogoMark.svg`.
- Record sources and retrieval date in `public/assets/brands/README.md`.
- Preserve each logo's aspect ratio, geometry, colors, and clear visual space.
- Do not skew, outline, redraw, recolor, or place effects directly on the Solana mark. Animate surrounding rails and light fields instead.

## Four Scenes

### 01 Price, Pyth Lazer

Upgrade the chart into a live market scanner. A bright scan line sweeps across a more dimensional price trace while ticker digits flip, price nodes pop in sequence, and a small LIVE badge pulses. The scene begins readable in its paused state with the full trace and current price visible.

### 02 Execution, MagicBlock

Place the official MagicBlock logo inside a stable central rollup chamber. Three transaction shards arrive from the left on staggered paths, collapse into the chamber, and a confirmed packet exits to the right. A pressure ring and status text communicate compression and fast execution without animating or distorting the logo itself.

### 03 Settlement, Solana

Place the official Solana mark in the center of a three-rail settlement gate. Signed transaction lines converge from three directions, the rails close around the mark, and a settlement seal resolves below it. The mark remains stable and unfiltered while the framing rails, signature lines, and seal animate.

### 04 Social Open World

Replace the sparse grid with a compact neon city-and-road scene. Driver avatars enter from opposite sides, cars travel toward a shared destination, building windows wake up, and presence rings connect the nodes. The paused state shows the city, route, cars, and destination clearly.

## Shared Pipeline

- Give each scene a short three-beat loop: input, transformation, confirmation.
- Stagger card loops so activity appears to move Price to Execution to Settlement to World.
- Keep the existing connecting line across desktop cards, but add a traveling pipeline pulse.
- Preserve the existing 4-column desktop, 2-column tablet, and 1-column mobile layouts.
- Decorative scenes remain `aria-hidden="true"`; card copy remains the accessible explanation.

## Motion and Performance

- Animate only transform and opacity for repeating scene motion.
- The global Motion control, document visibility, section visibility, and reduced-motion state pause all optional scene animation.
- Avoid canvas, Three.js, external runtime assets, animated filters, and paint-heavy background-position changes.
- Mobile retains the same story with fewer secondary particles and shorter travel distances.

## Testing and Verification

- Add tests that require both local brand assets, source attribution, logo image hooks, all four upgraded scene hooks, and the pipeline pulse.
- Protect the no-canvas and production dependency contracts.
- Verify focused tests, production build, desktop and mobile layout, motion pause behavior, console output, and horizontal overflow.

## Acceptance Criteria

- MagicBlock and Solana are identifiable at a glance through canonical marks.
- The actual marks remain crisp, correctly proportioned, and visually stable.
- All four scenes feel like one cinematic data pipeline rather than independent diagrams.
- Every scene still communicates in a paused frame.
- Motion Off and reduced motion stop every optional scene animation.
- Desktop, tablet, and mobile layouts have no clipping or horizontal overflow.
