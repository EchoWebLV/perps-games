# Swept Pickup Collision Design

## Problem

Pickup collection currently tests a coin against a fixed lateral radius around the car center and a narrow world-Z window. During a fast turn, the rendered car nose can visibly overlap a coin while the center remains outside that radius. At high road speed, a pickup can also move from before the Z window to beyond it in one frame and never be tested inside the window.

## Chosen behavior

Collection will use the car's rendered pose and sweep pickup motion across the entire frame:

- Treat the car as an oriented rectangular footprint expanded by the pickup radius.
- Transform the pickup's previous and current positions into car-local space using the rendered yaw.
- Sweep the segment between those positions against the expanded footprint so high-speed crossings count.
- Include the car's previous and current lateral positions so a fast turn cannot skip a side contact.
- Preserve the existing magnet pull and its wider lateral backstop.
- Keep `collect=false`, coin values, scrap values, recycling, and visual behavior unchanged.

## Integration

`Pickups.update` receives an optional car pose containing previous X, rendered yaw, and fixed Z. The main loop captures the prior lane X before stepping steering, then supplies both positions and `car.group.rotation.y` to pickup collision.

Older callers retain the current defaults, which keeps focused unit tests and non-driving uses compatible.

## Regression coverage

- A visible front-corner crossing during a hard turn is collected.
- A centered pickup that crosses the full catch area in one fast frame is collected.
- A pickup beyond the actual car footprint remains uncollected.
- Existing magnet, scrap, recycling, and multiplier tests continue to pass.
