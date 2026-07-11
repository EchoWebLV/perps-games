# Local Emote Feedback Design

## Goal

Make the three lobby emote buttons match the 42px hamburger button and show every server-accepted emote above its sender's car, including the local player's car.

## User Experience

- The emote rail remains below the hamburger and safe-area aware.
- Each emote button is exactly 42px by 42px, matching the menu button.
- Button order remains `😂`, `🔥`, `💀`.
- The existing button pulse remains immediate local tap feedback.
- A 3D emoji appears above the local car only after the presence server accepts and echoes the event.
- Remote emojis continue to appear above remote cars.
- Offline or rate-limited taps do not create a local 3D emoji that other players cannot see.

## Architecture

Extract the current Three.js glyph texture and sprite animation into a reusable emote-visual module. The module owns the exact glyph/color mapping, creates shared textures for its visual instances, and exposes `pulse(kind)`, `update(dt)`, and `dispose()` behavior.

`remote-cars.ts` continues to own one shared emote resource set for all remote drivers. `main.ts` creates one local emote visual, attaches its sprite to the local car group, and updates it in the normal frame loop.

The presence snapshot stores the current local presence ID. On an echoed emote event:

- If `event.id` equals the local ID, pulse the local car's visual.
- Otherwise, forward the event to the existing remote-car renderer.

The server protocol and two-emotes-per-second rate limit remain unchanged.

## Failure Handling

- Emote rendering remains optional and visual-only.
- Local and remote renderer exceptions stay contained so they cannot interrupt driving.
- Unknown or stale events continue to be rejected by existing typed protocol and nonce checks.
- The local visual uses the same bounded 0.7-second animation as remote visuals.

## Testing

- HUD tests assert all three buttons are exactly 42px square and remain ordered and accessible.
- Emote visual tests verify glyph selection, animation reset/update, and disposal.
- Routing tests verify self events choose the local visual and other events choose the remote renderer.
- Existing client presence, HUD, remote-car, production build, and browser checks must remain green.

## Out of Scope

- No new emotes, protocol messages, cooldown UI, chat, history, unlocks, or gameplay effects.
- No optimistic local 3D emoji for rejected or offline taps.
- No changes to server rate limiting or presence payload privacy.
