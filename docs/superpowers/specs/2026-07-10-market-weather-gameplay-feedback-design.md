# Market Weather Gameplay Feedback

**Date:** 2026-07-10
**Status:** approved design
**Scope:** Redline race world only

## Goal

Make live market movement legible through the road and atmosphere so the race world communicates what the price is doing before the player reads the numbers.

Four signals drive four effects:

1. Volatility visually narrows the road and intensifies traffic.
2. Momentum bends the road uphill or downhill.
3. Sudden price movement sends a visible shockwave through the world.
4. Approaching liquidation progressively deteriorates the environment.

The effects provide feedback and tension. They never change settlement, leverage, steering limits, collision, or the player's ability to cash out.

## Design principles

- **Market truth stays separate.** Price and liquidation buffer feed the visual system, but the visual system never feeds the Round engine or on-chain calls.
- **Percent movement is asset-neutral.** BTC, ETH, and SOL use percentage returns, not absolute price changes.
- **Sustained movement beats noisy ticks.** Momentum and volatility are smoothed before reaching the world.
- **A stale feed calms the world.** Visual signals ease toward zero when the feed is not live.
- **No surprise punishment.** Traffic has no colliders and road narrowing does not change the steering clamp.
- **Mobile performance is a feature.** Every effect has a reduced-detail form and bounded object count.
- **Car identity remains intact.** Skull's Death's Door stays the strongest final-stage liquidation effect.

## Approaches considered

### Direct changes in `main.ts`

Each effect could be calculated and applied in the frame loop. This is fastest initially, but signal definitions, smoothing, thresholds, and visual state would spread across the largest file in the game. It would be difficult to test or tune without loading the whole application.

### Unified Market Weather module

A pure stateful module converts price observations and liquidation buffer into normalized signals. Rendering modules consume those signals. This keeps settlement isolated and makes each threshold deterministic in tests.

This is the selected approach.

### Shader-only weather

All effects could be packed into the road and post-processing shaders. This gives the most visual freedom, but makes traffic, shock events, quality tiers, and test control harder. It also increases mobile GPU risk.

## Market Weather signals

Add `redline3d/src/core/market-weather.ts`.

```ts
interface MarketWeatherFrame {
  volatility: number; // 0..1
  momentum: number;   // -1..1, negative down and positive up
  shock: number;      // 0..1 decaying pulse
  shockId: number;    // increments once per accepted shock
  danger: number;     // 0..1 from liquidation buffer
}
```

The module accepts positive price observations, feed liveness, frame time, Round liveness, and the current liquidation buffer. It owns the last observed price, recent return history, smoothing state, shock cooldown, and signal decay.

Repeated reads of the same price are ignored for return calculation. A frame still advances easing and shock decay.

### Volatility

- Calculate absolute percentage return when a new positive price arrives.
- Smooth it with a short exponential moving average.
- Map a smoothed per-update move at or below `0.01%` to calm.
- Map a smoothed move at or above `0.12%` to maximum visual volatility.
- Clamp the public signal to `0..1` and ease visual consumers independently.

The thresholds are tuning defaults, not economic constants.

### Momentum

- Calculate signed percentage return from the same observations.
- Smooth signed movement over roughly two seconds.
- Map cumulative smoothed movement of `0.15%` in either direction to full visual momentum.
- Ease back toward zero when movement stalls.

Momentum is directional. Volatility is not. Alternating up and down movement may produce high volatility while momentum remains near zero.

### Shock

A new observation triggers a shock when its absolute percentage move is at least the larger of:

- `0.08%`, or
- `2.5` times the recent smoothed absolute move.

An accepted shock increments `shockId`, starts `shock` at a strength derived from the move, and begins a one-second cooldown. The pulse decays to zero in about `0.8` seconds. The cooldown prevents rapid feed bursts from producing constant flashing.

### Danger

Danger is active only during a live Round.

- Buffer at or above `0.35` produces `0` danger.
- Buffer at `0` produces `1` danger.
- Values between use a smoothstep curve.
- Leaving the live Round eases danger rapidly back to zero.

## Effect 1: volatility road squeeze and traffic

### Road squeeze

Extend the race World's road shader with a normalized weather uniform.

- At calm, road width is unchanged.
- At maximum volatility, illuminated shoulders and edge markings move inward by roughly `18%`.
- The underlying geometry, player steering clamp, pickups, and collision behavior remain unchanged.
- The transition eases over about one second so the road never snaps between widths.

The effect communicates reduced breathing room without changing financial control.

### Traffic

Add `redline3d/src/render/market-traffic.ts`.

- Traffic consists of pooled low-poly silhouettes and light streaks moving along the far road corridor.
- Traffic never collides with the player and never blocks the cash-out control.
- Calm traffic is sparse.
- Volatility increases active traffic count, relative speed, headlight intensity, and lane-change frequency.
- Full detail uses at most `14` active traffic objects.
- Reduced detail uses at most `6` active traffic objects and omits any dynamic lights.
- No object is created inside the frame loop.

## Effect 2: momentum terrain

The current terrain bias uses the smoothed price's displacement from a slow average. Preserve that response, but blend it with the new directional momentum signal.

- Existing displacement contributes at most `45%` of the final hill bias.
- Momentum contributes up to `5.5` world units of bias.
- The combined result remains clamped to the existing `-7..7` range.
- Positive momentum produces a sustained climb.
- Negative momentum produces a sustained descent.
- Momentum easing prevents isolated ticks from jerking the camera or car pitch.

The terrain remains decorative. The Round engine continues to read only the market price.

## Effect 3: sudden-move shockwave

Add `redline3d/src/render/market-shock.ts`.

Each new `shockId` triggers one event:

- A luminous ring expands from the horizon toward the player.
- Road grid emission and roadside lamps pulse once.
- The camera receives a small impulse through the existing chase-camera shake mechanism.
- The effect color follows direction: green-cyan for an upward move and red-magenta for a downward move.
- The direction is derived from the signed return that triggered the shock.

The shock has no collision and no gameplay consequence. Reduced detail uses the ring and color pulse but skips extra particles.

## Effect 4: progressive liquidation deterioration

Add `redline3d/src/ui/market-danger.ts` and allow the World to consume the normalized danger signal.

As danger rises:

- Saturation drains from the scene.
- A red-black vignette closes inward.
- Fog thickens and shifts toward dark red.
- Road-grid and edge glow weaken.
- Roadside lamps become less reliable without changing the real point-light count.
- A low heartbeat pulse appears in the vignette near maximum danger.

The overlay has `pointer-events: none`, so the cash-out button remains usable at every intensity.

Skull's Death's Door remains separate. Market danger builds for every Car; Death's Door layers over it only for Skull and controls the final grace-window presentation.

The danger overlay avoids setting a competing CSS filter on `#gl`, so it cannot overwrite Death's Door's existing `dd-scene` filter.

## Data flow

```text
PriceSource + Round snapshot
          |
          v
Market Weather module
          |
          +--> World weather uniforms
          +--> Market traffic pool
          +--> Market shock event
          +--> Market danger overlay
```

`main.ts` creates the modules and passes signals between them. It does not implement signal math or effect internals.

The market observation runs from the shared race price sample. World consumers update only in race mode. A new Round resets shock history and danger state but keeps the longer-lived price baseline so the first live tick does not create a false shock.

## Error and lifecycle behavior

- Invalid or non-positive prices are ignored.
- Asset changes reset price history, momentum, volatility, and shock cooldown.
- A stale feed eases volatility and momentum to zero and suppresses new shocks.
- Leaving race mode hides traffic, shock, and danger state.
- Ending a Round immediately begins danger recovery.
- Reduced-motion browser preference disables camera impulse and shortens large luminance pulses.
- All overlays remain non-interactive.

## Development controls

In development only, expose a small weather probe through the existing diagnostic surface. It can force `volatility`, `momentum`, `shock`, and `danger` values without altering Round state.

This probe exists for browser verification and is stripped from production builds.

## Testing

### Unit tests

`market-weather.test.ts` covers:

- Flat price remains calm.
- Sustained positive movement creates positive momentum.
- Sustained negative movement creates negative momentum.
- Alternating movement creates volatility without directional momentum.
- Percentage-based signals behave the same at different asset prices.
- A qualifying sudden move triggers exactly one shock.
- Shock cooldown suppresses immediate repeats.
- A stale feed decays weather and suppresses shocks.
- Danger begins below `0.35` buffer and reaches `1` at liquidation.
- Idle Round state clears danger.
- Reset clears asset-specific observation state.

Pure visual-mapping tests cover road squeeze, traffic count caps, hill-bias clamping, and danger intensity.

### Browser verification

For each effect:

- Force calm, mid, and maximum values through the development probe.
- Verify the effect in full and reduced detail.
- Verify the cash-out control stays visible and clickable at maximum danger.
- Verify Skull's Death's Door still layers correctly.
- Verify changing asset clears old weather.
- Verify no console errors.
- Check active traffic counts remain within their quality-tier caps.

The complete slice is also exercised against the live feed in practice mode before using a real Round.

## Commit sequence

Every slice includes its tests and verification before commit.

1. `feat(client): add market weather signal model`
2. `feat(client): make volatility squeeze the road and intensify traffic`
3. `feat(client): drive terrain pitch from market momentum`
4. `feat(client): add sudden-move market shockwave`
5. `feat(client): deteriorate the world near liquidation`
6. `test(client): verify integrated market weather feedback`

The design document and implementation plan are committed separately before code begins.

## Non-goals

- No change to settlement, leverage, liquidation thresholds, or on-chain instructions.
- No traffic collisions.
- No dynamic steering clamp or forced lane movement.
- No new server data.
- No audio redesign beyond a restrained danger heartbeat if the existing audio module can supply it without a new asset.
- No weather in the Strip, Garage, or Highway modes.
- No WebGL post-processing pass added solely for this feature.

## Success criteria

- A player can infer calm, volatile, trending, shocked, and near-liquidation states from the world without reading the HUD.
- Visual feedback remains deterministic for a given signal frame.
- The player retains full control of steering and cash-out.
- Settlement output is identical with Market Weather enabled or disabled.
- Reduced-detail mode stays within the declared traffic caps and uses no additional dynamic lights.
