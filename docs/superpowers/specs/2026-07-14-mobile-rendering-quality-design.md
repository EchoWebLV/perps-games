# Mobile Rendering Quality Design

## Problem

The Android APK and weak mobile browsers use the low rendering tier. That tier keeps the authored bloom look and a stable 30 FPS cadence, but it disables multisampling in the post-processing composer. Bright geometric edges therefore reach the bloom threshold without anti-aliasing, which can make neon lamps and other high-contrast details shimmer while driving.

Roadside lamps also have an intentional dying-fixture effect. The same visibility flag currently controls both the local lamp mesh and the real point light that illuminates the car and nearby scene. At mobile's 30 FPS cadence, the fast fixture flicker aliases into abrupt changes from a high-intensity point light. Bloom amplifies those changes into a screen-wide flash.

## Goals

- Improve mobile and APK edge quality before bloom.
- Preserve the current low-tier 30 FPS cap and its existing resolution, bloom, and scene-detail budgets.
- Keep atmospheric fixture flicker without changing the road or car illumination.
- Leave the high rendering tier visually and behaviorally unchanged.

## Non-Goals

- Do not raise the mobile device-pixel-ratio cap above 1.25.
- Do not raise low-tier bloom resolution above 0.5.
- Do not restore full decorative scene detail on weak devices.
- Do not introduce dynamic quality switching or a user-facing graphics menu.
- Do not change gameplay, camera motion, market-shock effects, or intentional end-of-round UI flashes.

## Rendering Profile

The low tier will use 2x multisampling on the EffectComposer render targets instead of zero samples. Multisampling occurs on the scene render before UnrealBloomPass evaluates bright pixels, so it stabilizes the edges that currently shimmer and feed inconsistent values into bloom.

All other low-tier settings remain fixed:

- `frameCapFps: 30`
- `pixelRatioCap: 1.25`
- `bloom: true`
- `bloomScale: 0.5`
- `detail: "reduced"`
- `postSamples: 2`

The high tier remains at 4x composer multisampling, device-pixel-ratio cap 2, full-resolution bloom, full detail, and no frame cap.

Two samples are the highest safe default for the known Mali-class target under the existing mobile budget. Forcing desktop's 4x resolve on all mobile devices would provide stronger edge coverage but risks violating the requirement to retain the current frame rate. FXAA was rejected because its single post pass can soften fine neon geometry. SMAA was rejected because the installed implementation adds three full-screen passes and two additional half-float render targets.

## Stable Lamp Illumination

Lamp state remains split into three authored modes: normal, dead, and dying. Dead lamps remain unavailable to the pool of point lights. Dying lamps keep toggling only their fixture objects, such as the bulb, halo, beam, or flame meshes.

The real point-light target will no longer read the dying fixture's visibility. Once a non-dead lamp is selected for a real point light, illumination depends only on distance, theme color, and the existing market-shock boost. Existing cross-fading and reassignment behavior remains unchanged, so the light contribution stays continuous as lamps move past the car and recycle.

This keeps local visual character while preventing a dying bulb from switching a high-intensity world light between full strength and zero.

## Data Flow

1. Device detection selects the low or high `Quality` profile.
2. `main.ts` applies the profile's pixel-ratio cap and passes `postSamples` into `createPost`.
3. `createPost` applies the selected sample count to both composer render targets before bloom.
4. During world updates, fixture visibility animates independently from the point-light target.
5. The existing 30 FPS gate decides when the low tier renders a frame. No timing behavior changes.

## Compatibility and Fallback

The project uses Three.js WebGL2 rendering. Three.js clamps multisample render-target storage to the renderer's supported maximum, so the requested two samples do not require a separate capability branch. The existing direct-render fallback remains available when bloom is disabled by a future profile, although current profiles keep bloom enabled.

No APK-native code or Capacitor configuration changes are required. The APK receives the behavior through the normal web asset build.

## Testing and Verification

Implementation follows test-driven development.

- Update the low-tier quality regression test first so it fails while `postSamples` is still zero, then set the profile to two samples.
- Add a deterministic lamp-light test that proves a dying fixture being hidden does not zero the corresponding world-light target, while a dead lamp remains excluded.
- Run the focused rendering and performance tests.
- Run the complete Vitest suite and production web build.
- Build the APK to verify the web changes package successfully.
- Inspect a mobile viewport while driving to confirm neon edges are smoother, fixture flicker remains local, and the road and car no longer pulse.
- Use the existing FPS meter on a physical Seeker for final device confirmation that the game continues to present at the 30 FPS cap.
