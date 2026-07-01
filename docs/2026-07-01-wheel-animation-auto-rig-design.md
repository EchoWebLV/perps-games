# Wheel Animation Auto-Rig — Design

**Date:** 2026-07-01
**Status:** Approved approach (offline auto-rig + runtime spinner), detection algorithm proven by prototype against all 13 GLBs.

## Goal

Every car in redline3d gets spinning wheels (rolling at physically correct rate for the current road speed) and front-wheel steering — across all 13 GLB models, with no per-model hand work and no car left static.

## The problem

The 13 models in `redline3d/public/models/` are structurally inconsistent:

- **2 models** have named wheel nodes: delorean (`Wheel_Front_L`…), flintstone (`flinstone car wheel front`… — plus a `steering wheel` node that must be excluded).
- **3 models** have wheels as separate but unnamed/loosely named meshes: orion (`wheel_f`/`wheel_b`), cybertruck (`Object_N`), vaporwave (`Object_N`).
- **8 models** (clown-car, skull, pink-rod, six-wheeler, shopping-cart, slot-machine, starter, helmet) are **one fully welded mesh** (376k–794k verts, 1–4 connected islands). Wheels share vertices with the body; there is no node to rotate. Topology-based splitting provably fails (prototype: clown-car = 4 islands for 538k verts).

## Detection algorithm (proven 2026-07-01)

Prototype run against all 13 real GLBs (none are Draco-compressed; plain float32 geometry):

1. **Ground-contact clustering** — wheels are the only geometry touching the ground. Take vertices in the bottom 2.5% of model height, cluster in XZ → one cluster per wheel. Found: clown-car 4, skull 4, pink-rod 4, six-wheeler **6**, helmet 4, slot-machine 4, starter 4, shopping-cart 4 (+dupes), cybertruck 4, orion 4, vaporwave 4.
2. **Circle fit** — per contact cluster, 1D/2D search over (radius, z-offset) maximizing vertices lying on the circle in the YZ side profile within an x-slab. Yields hub center + radius (7k–17k inliers per wheel on baked models — unambiguous). Correctly detected pink-rod's and skull's smaller-front/bigger-rear stance.
3. **Named-node path** — models with wheel-named nodes (delorean, flintstone) skip geometry surgery; their nodes are re-pivoted/renamed instead. (Delorean's contact detection finds 0 clusters — its named nodes are the fallback that covers it.)

Known adjustments for the production script (found by prototype):

- Lower the radius-search floor (starter's fit bottomed out at the 2%-of-length search limit).
- Merge overlapping circle candidates (shopping-cart double-detects its casters).

## Part 1 — offline auto-rig script

`redline3d/scripts/rig-wheels.mjs`, run once per model; rewritten GLBs committed to git (originals recoverable via git history).

- Parse GLB directly (JSON + BIN chunks; prototype parser already works) or via `@gltf-transform/core`.
- **Named path** (delorean, flintstone, orion): find nodes matching `/wheel|tire/i` excluding `/steering/i`; re-pivot at hub center, rename to convention.
- **Geometry path** (everything else): detect hubs per the algorithm above, then cut: triangles whose centroid falls inside a conservative cylinder around the hub (radius ×~1.05, measured axle width padded) move to a new primitive sharing the body's material. Boundary cut edges sit inside the wheel well — not visible.
- **Output convention per wheel:** its own node named `wheel_0…n`, pivot at hub center, identity orientation (local X = axle), geometry rebased to the pivot.
- **Sanity gates** (loud failure, no silent skips): ≥4 wheels per car, mirrored left/right pairs, radii within sane ratio; print per-model report (position, radius, vert count).

## Part 2 — runtime spinner (`redline3d/src/render/car.ts`)

- On model load, collect wheel nodes (`/^wheel_\d+$/` plus legacy `/wheel/i` minus `/steering/i`).
- Radius from each wheel's world bounding box (post-normalization, so units match world speed).
- **Front classification is geometric** (wheel z vs. car center after model yaw — car nose faces −Z), replacing the fragile `/wheel.*front/i` regex. Steering applies to the front axle pair only; spin applies to all wheels.
- Per frame: `wheel.rotation.set(spinAngle, steerAngle, 0, 'YXZ')`, `spinAngle += (speed / radius) * dt`. Clean composition because the rig baked identity pivots. Spin direction sign verified visually once.
- API: `car.update(dt)` → `car.update(dt, speed)`. Both call sites in `main.ts` already have speed in scope (race road speed at ~line 615, lobby `drive.speed`). Race mode: the world scrolls under a stationary car, so road speed is exactly the wheels' rolling speed.

## Testing & verification

- Vitest for pure runtime helpers (front/rear classification, radius-from-bbox, spin math).
- Rig script prints a per-model report; run over all 13 must pass sanity gates.
- **Browser verification (mandatory per project rule):** cycle all 13 cars in Claude Preview — wheels spin while driving, fronts steer, nothing orbits (a mis-cut fender chunk would orbit the hub — the one visual failure mode to eyeball for).

## Risks & mitigations

- **Cut grabs non-wheel geometry** (brake/fender fragment orbits): conservative cylinder radius; per-model eyeball pass; worst case tighten that model's cut and re-run the script.
- **Browser caches old GLBs** after rewrite: same filenames kept; bust via preview restart in dev; add `?v=` query to model URLs if needed for deployed clients.
- **Perf:** +4–6 draw calls for the active car only; per-frame cost is rotating ≤6 nodes. GLB sizes unchanged (same triangles, a few extra nodes).

## Revision 2026-07-02 (v2, after in-browser feedback "tires too small / glitching")

The single circle-fit didn't survive contact with all 13 models. Final shipped detection is **four paths**, selected per model:

- **ground-contact + coverage fit** (clown-car, skull, pink-rod, six-wheeler, shopping-cart, slot-machine, starter, helmet): the density-scored fit locked onto rim circles (undersized wheels); replaced with *largest ground-tangent circle whose inside band has full 360° angular coverage* (a tire is a full circle, a fender arc isn't; band just inside the edge kills the nested wheel-arch circle, which is also ground-tangent), cross-checked by the *vertical column above the contact point* (solid tire → air gap = true diameter).
- **tagged joints** (delorean — the whole car is a skinned mesh; wheels are bones) and **tagged nodes** (flintstone rollers, orion `wheel_f`/`wheel_b` axle pairs): extras stamped in place, rest pose preserved; the runtime composes rest × steer(up) × spin(axle) from node-local axes in the extras.
- **node-shape** (cybertruck): wheels are separate unnamed mesh nodes (tire + rim per wheel = 8 nodes / 4 wheel groups); the node IS the wheel.
- **island split** (vaporwave): wheels are 4 disjoint triangle islands inside one merged-by-material mesh; union-find capture is exact.

Two bugs found only by visual verification: the cut rebase used R instead of R⁻¹ for Z-axle wheels (every cut wheel rendered 180°-flipped around its hub — the "glitch all over the place"), and the six-wheeler's middle axle steered (front-axle z-tolerance 25% → 12%). **Verification that worked:** re-baking the garage card art (`npm run bake:cards`) from the rigged GLBs and diffing against the originals — pixel-identical = 1:1 cut; the adversarial offline pass flagged "leftover tires in the body," which turned out to be dead (unreferenced) vertices in the position buffers — not rendered, only file bloat. Roll direction proven on live data (Δangle = speed·dt/r about car −X).

- Caster swivel on shopping-cart (spin only, like every other wheel).
- Suspension/bounce animation.
- Any change to game logic, economics, or on-chain code.
