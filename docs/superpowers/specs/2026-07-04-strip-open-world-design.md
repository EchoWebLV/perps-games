# The Strip — open-world garage hub (design)

**Date:** 2026-07-04 · **Branch:** `intro-clarity` · **Status:** approved in-chat

## Problem

The garage/upgrades/crates/track hub lives in a separate scene behind an unlabeled
map-pin button on the intro screen. Fresh players never find it; the intro world reads
as an empty lot. The user's direction: the garage becomes an **open-world element where
people meet** — a social space, not a hidden menu.

## Design

One continuous world. The hub merges into the main (race-mode) world as **the strip**:
you spawn on a plaza ringed by the four buildings, dressed as a car-meet spot. The
separate parking-lot scene and its pin-teleport are retired.

Components, in build order (each slice browser-verified before the next):

1. **Buildings on the strip** — GARAGE / UPGRADES / CRATES / TRACK placed around the
   plaza in the main world, visible from spawn, with their existing neon signs and
   park-in-ring door zones (garage → car picker, upgrades → upgrades shop,
   crates → coming-soon toast, track → highway free-drive).
2. **Parked hero cars + name tags** — 4-5 hero GLBs angled into spots, headlights on,
   floating name-tag sprites. Presence-ready: tag + spawn-slot structure is what real
   players will occupy later.
3. **Leaderboard billboard** — neon board cycling recent action ("skull_rider banked
   ×14.2"). Locally simulated feed now; exported hook for real settles later.
4. **NPC cruisers** — 1-2 cars on a perimeter loop, simple spline followers, no AI.

## Constraints

- GO / bet flow unchanged — the round launches off the strip; betting stays center stage.
- Race-mode terrain is generated from the live price around the car; the strip geometry
  must coexist with the launch corridor (de-risk first — this is the one open technical
  question).
- Seeker GPU budget: ≤5 parked cars, ≤2 cruisers, one canvas texture for the billboard.
- No networking in this phase. Real presence is a later, separate project.

## Out of scope

Multiplayer backend, VRF crates content, any on-chain change.
