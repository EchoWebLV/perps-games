# Redline — the prototype journey

The full evolution of **Redline**, in order, so you can open each version and watch the idea grow from a 2D canvas toy into the 3D arcade perp game. Recovered from this project's own development history (git object tree + session transcripts), then the 3D milestones rebuilt from their exact commits.

Open **`index.html`** for a clickable launcher. The 2D versions are single files; each 3D version is a self-contained built folder (open its `index.html`).

## 2D era — the original single-file prototype
| # | when | size | what | open |
|---|------|------|------|------|
| 1 | 2026-06-16 10:30 | 18KB | REDLINE — leveraged ride | `01-2026-06-16_1030-2d-redline-leveraged-ride.html` |
| 2 | 2026-06-16 10:40 | 20KB | REDLINE — leveraged SOL ride | `02-2026-06-16_1040-2d-redline-leveraged-sol-ride.html` |
| 3 | 2026-06-16 11:06 | 20KB | REDLINE — ride the SOL road | `03-2026-06-16_1106-2d-redline-ride-the-sol-road.html` |
| 4 | 2026-06-16 18:37 | 28KB | REDLINE — ride the SOL road | `04-2026-06-16_1837-2d-redline-ride-the-sol-road.html` |
| 5 | 2026-06-17 18:47 | 28KB | REDLINE — ride the SOL road | `05-2026-06-17_1847-2d-redline-ride-the-sol-road.html` |
| 6 | 2026-06-17 20:59 | 34KB | REDLINE — ride the SOL road | `06-2026-06-17_2059-2d-redline-ride-the-sol-road.html` |

> Versions 4–6 load the bundled `feed.js` (live Pyth Lazer client). Keep it in this folder.

## 3D era — rebuilt from each milestone commit (all 2026-06-18)
| # | time | what | built from | open |
|---|------|------|-----------|------|
| 7 | 10:26 | First playable 3D — synthwave Redline (the leap from 2D) | `7370a16` | `07-3d-first-playable-synthwave/index.html` |
| 8 | 10:57 | Speed feel — rushing roadside pylons + FOV / shake | `c4a2584` | `08-3d-speed-feel/index.html` |
| 9 | 11:01 | Real car + richer world (P2b) | `619e719` | `09-3d-real-car-richer-world/index.html` |
| 10 | 11:08 | Cockpit HUD + curved redline tachometer (P2c) | `ad907c9` | `10-3d-cockpit-hud-tachometer/index.html` |
| 11 | 11:29 | Lane steering + collectible pickups + minimap | `55b6ff9` | `11-3d-lane-steering-pickups-minimap/index.html` |
| 12 | 11:41 | Price-driven rolling terrain (road rises/dips with SOL) | `d5f417f` | `12-3d-price-driven-terrain/index.html` |
| 13 | 13:23 | Real DeLorean GLB + env-map reflections | `8828040` | `13-3d-real-delorean-glb/index.html` |
| 14 | 13:53 | Intentional arcade racing HUD redesign | `3ee7f85` | `14-3d-arcade-hud-redesign/index.html` |
| 15 | 17:07 | End-of-round FX — confetti on cash-out, smoke on liquidation | `9f91217` | `15-3d-end-of-round-fx/index.html` |
| 16 | 21:39 | Garage — tradable car cards with live rotating 3D models | `64aebaa` | `16-3d-garage-car-cards/index.html` |
| 17 | 21:40 | Clown Car lane-bet ability — steer to pick LONG / SHORT | `f76048a` | `17-3d-clown-car-lane-bet/index.html` |

## Notes
- The 3D era is the `redline3d/` Three.js + Vite project; these folders are `vite build` output of each milestone commit, fully self-contained and playable offline (SimSettlement — no backend, no wallet).
- After #17 the game grew a garage-town lobby, then a server, then on-chain settlement (MagicBlock ER + Pyth Lazer). Those no longer run as a standalone bundle (they need the server / devnet wallet) — to see the current game, run `redline3d/` with the dev server.
- Heads-up: the later 3D builds bundle large car GLBs (`orion.glb` ~37MB) and a splash video, so this folder is ~230MB. Don't commit it as-is without slimming.
