# Onboarding Road Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** One legible road into the game: first visit = crate rip (character creation) → spawn in the lobby driving the pulled car → jumbotron points at the new RACE building (anchor). The RACE gets its own building in the highway's plaza slot; TRACK reverts to the perps ring; the highway oval is parked (no door, boot-restore intact).

**Branch:** `onboarding-road` (cut from `paddock-race-book` @ 3de3e09f).

**Architecture:** All changes are client-side (redline3d). The plaza is data-driven via `RING_SPEC` in `src/core/lobby-layout.ts`; building art/signs render generically from `BUILDINGS`. The chain race already opens via `enterGrandprix` (grandprix = race-mode + chain book). The crate rip reuses the existing welcome-gift roll + reveal.

**User decisions (final):**
- Highway: parked entirely. No plaza door, no menu row. `enterHighway(true)` boot-restore of an open position MUST keep working.
- TRACK: back to the perps ring (`exitLobby()` → mode "race") — the reroute from 3de3e09f is reverted.
- RACE: new building in the highway's slot (deg −35), opens `enterGrandprix(equippedCar.name)`.
- First visit: rip → lobby. Returning visits: unchanged boot (home collection, WATCH & BET fast lane stays).

---

### Task 1: Plaza — RACE building replaces HIGHWAY; TRACK reverts to perps

**Files:**
- Modify: `redline3d/src/core/lobby-layout.ts`
- Modify: `redline3d/src/main.ts` (triggerBuilding + prompt copy + dead highway-from-lobby code)
- Modify: `redline3d/src/core/highway-access.test.ts` (source pins)
- Check (likely no change): `redline3d/src/render/lobby.ts` renders `BUILDINGS` generically — verify the new kind renders; `redline3d/src/ui/lobbyhud.ts` prompt cards.

**Steps:**
- [ ] In `lobby-layout.ts`: extend `BuildingKind` with `"race"` (KEEP `"highway"` in the union — parked code still names it). Replace the `highway` RING_SPEC entry `{ kind: "highway", deg: -35, w: 28, d: 12, color: 0xff6a3d, name: "HIGHWAY" }` with `{ kind: "race", deg: -35, w: 30, d: 12, color: 0xff2d55, name: "RACE" }` (slightly wider — it's the anchor; hot red-pink, distinct from TRACK green / CRATES pink 0xff39c0).
- [ ] In `main.ts` `triggerBuilding`: `case "race": enterGrandprix(equippedCar.name); break;` (with the comment that this is the chain-book race). Revert the track case to `case "track": exitFrom = "track"; exitLobby(); break;` (perps ring — restore the original comment about the racing chrome/GO). Delete the whole `case "highway"` block and `enterHighwayFromLobby()` (now unused; boot-restore uses `enterHighway(true)` directly — verify with grep before deleting, and leave `enterHighway`/`exitHighwayToLobby` untouched).
- [ ] Find the door-prompt/offer-card copy map for buildings in main.ts/lobbyhud (grep `TRACK` / `HIGHWAY` string literals near `setPrompt`). Give "race" its card (e.g. title `RACE`, sub "bet the field — real SOL"), delete the highway card.
- [ ] `backOutToHome`'s `mode === "highway"` branch stays (parked mode, still a valid state via boot-restore).
- [ ] Update `highway-access.test.ts`: the "gates only the Highway building branch" test must change — the lobby branch is gone. Keep the pure `highwayEntryDecision` unit tests. Replace the branch-pin test with pins asserting the new truth: main.ts contains `case "race": enterGrandprix(equippedCar.name);` AND `case "track": exitFrom = "track"; exitLobby();` AND does NOT contain `case "highway"`. If `highwayEntryDecision`/`capacitorNative` become unimported in main.ts, remove the dead import and drop those pins.
- [ ] Run `npx vitest run src/core/highway-access.test.ts src/core/lobby-layout.test.ts` (if the latter exists) + `npx tsc --noEmit`. Expected: green.
- [ ] Browser check (dev server `redline3d-paddock`, port 4200, `?wallet=dev`): lobby shows RACE building at north-west with its ring; driving into it is NOT required for this task (grandprix entry already proven) — a screenshot of the building + prompt card is enough.
- [ ] Commit: `road: the RACE gets the anchor building; TRACK back to perps; highway parked`

### Task 2 (DEFERRED — user cut scope 2026-07-29 to Task 1 only: "just replace highway with the race... Call the building Race, that's it"): Jumbotron — live race marquee

**Files:**
- Modify: `redline3d/src/render/billboard.ts` (StripBillboard)
- Modify: `redline3d/src/main.ts` (feed it in the lobby frame branch)
- Possibly use: `redline3d/src/chain/paddock.ts` read helpers (an out-of-band race reader exists — the devnet tests read the race without a funded signer).

**Steps:**
- [ ] Add to `StripBillboard` a `setRace(line: string | null)` (null → fall back to the existing simulated feed). Style consistent with current board drawing.
- [ ] In main.ts: a lazy read-only race reader (public devnet ER read via the same config the paddock client uses; NO signer, NO paddockFor() dependency — guests must see it). Poll at ≤1 Hz while mode === "lobby" only. Derive: phase + seconds remaining from `phase_ends_ts` + pool total. Render `NEXT RACE 0:32 · POOL 0.84 SOL` during non-MARKET phases and `BETS OPEN 0:12 · POOL 0.84 SOL` during MARKET. On read failure: `setRace(null)` (board falls back; never throws into the frame loop).
- [ ] Unit-test the formatter (pure function phase+ends+pool → line) in a new small test file; don't test the RPC.
- [ ] `npx tsc --noEmit` + targeted vitest green.
- [ ] Browser check: lobby jumbotron cycles the live line within ~5s of entry (dev server, chain reachable).
- [ ] Commit: `road: the jumbotron sells the next race`

### Task 3 (DEFERRED — same scope cut as Task 2): First-visit crate rip → spawn in the lobby driving it

**Files:**
- Modify: `redline3d/src/main.ts` (boot sequence)
- Reuse: the existing welcome-gift roll + crate reveal (`maybeWelcomeGift` at ~main.ts:2550, cratebox/crate-cinematic modules)
- Test: extend whatever pins the boot flow (grep for boot/`enterHome` tests; if none, add a small pure-logic test for the first-visit predicate).

**Steps:**
- [ ] First-visit predicate (pure, testable): no saved identity AND no `slop:road-ripped` localStorage flag AND the guest welcome-gift flag not already set (reuse the existing welcome-gift once-flag if one exists — do NOT double-grant).
- [ ] Boot: when first-visit → instead of landing on home, run the crate rip immediately: same roll as the guest welcome gift (local grant, rarity roll, full reveal cinematic), single CTA ("OPEN YOUR CRATE"). No sign-in required (guest-local; the once-per-account server crate at sign-in stays as-is — separate system, keep the existing dedupe behavior unchanged).
- [ ] On reveal end: set the flag, `equipByName(<pulled car>)` (if drivable; a non-drivable pull → keep default equip), then enter the LOBBY directly (the same path home's DRIVE THE STRIP takes), skipping home. The existing first-lobby how-to ("Take the wheel") stays — it teaches driving exactly then.
- [ ] Returning visit (flag/identity present): boot unchanged (home collection).
- [ ] Guard: if the rip overlay errors for any reason, fall through to the normal home boot (never a dead end).
- [ ] `npx tsc --noEmit` + full `npx vitest run` green.
- [ ] Browser check in a FRESH profile/incognito-equivalent (clear localStorage via devtools protocol or `localStorage.clear()` then reload): boot → rip → lobby in the pulled car. Then reload again: normal home boot (flag respected).
- [ ] Commit: `road: first visit rips a crate and wakes up driving it`

---

**Out of scope (deliberately):** scrapyard/coins/scrap changes, menu changes, home layout changes, any highway UI resurrection, weighted draws/entries. The WATCH & BET home button stays as the returning fast lane.

**Final verification (controller):** fresh-profile browser run of the whole road (rip → lobby → RACE building → live race opens → bet panel gated as built), returning-profile run (home boot unchanged, WATCH & BET works), full suite + tsc, then commit/report.
