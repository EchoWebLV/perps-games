# Lobby First-Load Fidelity and Emote Rail Design

Date: 2026-07-11

## Goal

Make the first uncached lobby reveal look like the stable reloaded lobby, and improve the multiplayer presence controls without crowding the top bar.

The finished lobby must:

- avoid exposing pink-lit procedural car placeholders during a normal cold load;
- keep a bounded escape path when a model genuinely cannot load;
- center `LIVE N` in the top safe area;
- place three emote buttons, `😂`, `🔥`, and `💀`, in a vertical rail below the hamburger menu;
- replicate the selected emote to other lobby players as a brief visual above the sender's car;
- remain playable when presence is offline or a model fails.

## Current Failure

The loading splash has a fixed nine-second safety timeout. The local car hides the splash when its first GLB succeeds, but the timeout can win on an uncached or congested first visit. The lobby then reveals the procedural fallback car under the pink and purple scene lights. Reloading reuses cached GLBs, so the intended materials and colors appear immediately.

The existing presence HUD also positions the live count and spark button together at the top right. That overlaps the hamburger's visual territory and leaves no clear place for more emotes.

## Rendering Design

The local hero car is the reveal gate. The splash remains visible until one of these terminal outcomes occurs:

1. The requested local GLB loads successfully. The splash completes and fades normally.
2. Twenty seconds elapse. The game reveals the lobby with a deliberately neutral fallback instead of trapping the player.
3. The local GLB fails. The game reveals the neutral fallback immediately after the failed request is known.

The procedural fallback remains available because local play must never depend on an asset request. Its standard materials will use neutral emissive and lighting values while it is the active representation. This prevents the fallback from reading as a fully pink car when the timeout or failure path is used.

Remote cars do not block the splash. They continue loading independently and retain the procedural fallback when an asset is slow or unavailable. This avoids making one remote player's model a startup dependency.

The car readiness callback reports `loaded` or `failed`. A small boot-reveal controller owns the 20-second timer, converts it to the `timed_out` outcome, and completes the splash exactly once. Repeated or stale GLB callbacks must not dismiss the splash more than once.

## Presence Layout

The presence UI becomes two independently positioned elements owned by `ui/presence.ts`:

- A status chip fixed at the horizontal center of the top safe area using `left: 50%` and `translateX(-50%)`.
- An emote rail fixed to the top-right safe area, starting below the 42px hamburger button with an 8px gap.

The rail contains exactly three 32px square buttons in this order:

1. `😂` Laugh
2. `🔥` Fire
3. `💀` Skull

Each button has an accessible label, an independent local press animation, and pointer events only on the button itself. The rail and status chip are visible only in lobby mode. Opening the product menu continues to apply the existing HUD visibility policy.

Portrait and landscape use the same safe-area anchors. The centered status must not inherit the right-side landscape offsets used by the hamburger stack.

## Emote Protocol

The presence emote kind becomes the closed union:

```ts
type PresenceEmoteKind = "laugh" | "fire" | "skull";
```

Client frame:

```ts
{ type: "emote", kind: PresenceEmoteKind }
```

Server frame:

```ts
{ type: "emote", id: string, kind: PresenceEmoteKind, nonce: number }
```

The server validates the union strictly, preserves the existing rate limit, and broadcasts the selected kind. Unknown kinds are rejected as bad messages and never mutate room state.

The client API changes from `emote()` to `emote(kind)`. UI callbacks carry the selected kind through `main.ts` to the presence client. Remote rendering continues to deduplicate by nonce, but now renders the matching emoji and color treatment.

## Emote Visual

Each remote car owns one reusable emote visual anchored above its nameplate. The renderer creates the three glyph textures once and reuses them across events. Triggering an event selects the texture and color, restarts a short rise-and-fade animation, and records the nonce.

The treatments are:

- Laugh: `😂` with cyan and yellow glow.
- Fire: `🔥` with orange and red glow.
- Skull: `💀` with white and violet glow.

The visual lasts 700ms and allocates no new Three.js object or texture per event. A newer emote replaces and restarts the current one. Removed players dispose their sprite material through the existing remote-car cleanup path, while the renderer disposes the shared glyph textures once.

The sending player gets immediate feedback through the pressed button animation. The server echo remains remote-only because the local player is excluded from the remote registry.

## Failure Behavior

- Local model slow: keep the splash until success or the 20-second cap.
- Local model failed: show the neutral fallback and allow play.
- Remote model slow or failed: keep the neutral fallback for that player.
- Presence offline: show `LIVE OFFLINE`; buttons remain harmless and send nothing.
- Invalid emote kind: reject without broadcasting.
- Emote rate-limited: preserve the current connection and ignore the rejected send visually for remote players.

## Testing

### Rendering tests

- A successful first GLB load reports `loaded` once.
- A failed first GLB load reports `failed` once and retains the neutral fallback.
- A stale callback cannot complete readiness.
- The boot-reveal controller waits for readiness, times out at 20 seconds, and is idempotent.

### Presence protocol and transport tests

- All three client emote kinds parse and broadcast unchanged.
- Unknown kinds are rejected.
- The room preserves kind and increments nonce under the existing rate limit.
- The client serializes the selected kind and decodes all three server kinds.

### HUD tests

- `LIVE N` is centered independently of the right-side rail.
- The rail contains exactly `😂`, `🔥`, and `💀` in order.
- Each button dispatches its own typed kind exactly once for click and non-primary tap input.
- Only the three buttons accept pointer input.
- Lobby visibility hides and restores both UI regions together.

### Remote visual tests

- Each kind selects the expected glyph treatment.
- Repeated nonces do not retrigger.
- A newer nonce restarts the animation.
- Removal and disposal release the visual resources.

### Manual browser verification

1. Disable cache and enter the lobby from a fresh navigation. Confirm the splash remains until the local GLB appears, or the neutral fallback appears after the bounded failure path.
2. Reload and confirm the same car materials and scene color impression.
3. Verify `LIVE N` is centered at the top in portrait and landscape.
4. Verify the three-button rail sits below the hamburger without overlap.
5. Open two clients and send each emote in both directions.
6. Stop the presence server and confirm the lobby stays playable with `LIVE OFFLINE`.

## Out of Scope

- Text chat, emote history, cooldown UI, unlockable emotes, and moderation.
- Waiting for remote GLBs before revealing the lobby.
- Changing gameplay, economy, collision, races, or settlement.
