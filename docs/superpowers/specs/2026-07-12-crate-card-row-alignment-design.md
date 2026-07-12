# Crate Card Row Alignment Design

## Problem

The Silver crate displays five rarity odds, so its odds wrap to two lines. Wooden and Gold use one line. Because each card is a vertical flex column, the taller Silver odds block pushes its scrap reward and purchase buttons below the matching controls in the other cards.

## Design

- Reserve the same two-line vertical space for every crate odds block and center its contents within that space.
- Let each purchase block consume the remaining flexible space above it so the coin and cash buttons remain anchored to the same bottom rows.
- Preserve the current card dimensions, colors, copy, prices, odds, rewards, hover behavior, and responsive three-card layout.

## Verification

- Add a DOM-level regression test that checks the crate shop stylesheet contains both layout contracts.
- Run the focused crate box tests and the client build.
- Open the crate shop in a browser and confirm all three coin buttons share one horizontal line and all three cash buttons share another.

## Out of Scope

- Crate economics, payments, randomness, reveal animations, card artwork, and mobile redesign.
