# Live Paddock Multiplayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an eight-player realtime lobby where authenticated guest or wallet sessions see smooth remote cars, driver names, connection count, join/leave feedback, and one spark emote.

**Architecture:** Add an in-memory, transport-independent presence room behind one authenticated Fastify WebSocket route. Add a reconnecting browser client that sends local lobby poses at 10 Hz, then feed validated snapshots through pure motion smoothing into the existing lobby remote-car seam. Presence remains visual-only and fails open to the existing solo game.

**Tech Stack:** TypeScript, Fastify 5, `@fastify/websocket` 11, `ws` 8, Zod, browser WebSocket, Three.js, Vitest

## Global Constraints

- One global room with at most eight authenticated connections.
- The session token is sent only in the first WebSocket frame, never in the URL.
- Anonymous guest sessions are allowed.
- Presence exposes no database user id, wallet, balance, stake, settlement, or inventory ownership data.
- Client pose target is 10 Hz; server accepts at most 15 pose updates per second per connection.
- Emotes are limited to two per second per connection.
- Presence failure must never block solo driving, menus, practice, wallets, or on-chain rounds.
- Remote cars are visual-only and never participate in local physics or collision.
- No chat, parties, matchmaking, shared races, persistence, or player rewards.
- Use test-first red, green, refactor cycles for every behavior change.

---

## File Map

### Server

- `server/src/presence/protocol.ts`: wire types, runtime parsing, numeric normalization, public constants.
- `server/src/presence/protocol.test.ts`: malformed-message and normalization coverage.
- `server/src/presence/room.ts`: capacity, public ids, latest poses, rate limits, snapshots, emote fan-out.
- `server/src/presence/room.test.ts`: pure room behavior.
- `server/src/presence/socket.ts`: Fastify WebSocket adapter, first-frame authentication, timers, heartbeat, cleanup.
- `server/src/presence/socket.test.ts`: `injectWS` transport coverage.
- `server/src/http/server.ts`: register the WebSocket plugin before routes and mount presence.
- `server/src/index.ts`: construct the room and socket gateway.
- `server/src/test/harness.ts`: construct presence in test servers and expose it to tests.
- `server/package.json`, `server/package-lock.json`: add `@fastify/websocket` and `@types/ws`.

### Client

- `redline3d/src/core/remote-motion.ts`: pure position and wrapped-heading interpolation.
- `redline3d/src/core/remote-motion.test.ts`: frame-rate, angle-wrap, and snap coverage.
- `redline3d/src/core/presence.ts`: browser protocol, lifecycle, reconnect, snapshot diffs, 10 Hz pose throttle.
- `redline3d/src/core/presence.test.ts`: fake-WebSocket lifecycle coverage.
- `redline3d/src/core/presence-lifecycle.ts`: pure identity and mode connection gate.
- `redline3d/src/core/presence-lifecycle.test.ts`: lobby, race, and missing-identity lifecycle coverage.
- `redline3d/src/render/remote-cars.ts`: remote car registry, nameplates, model changes, emote pulse, disposal.
- `redline3d/src/render/remote-cars.test.ts`: injected car/nameplate factories and lifecycle coverage.
- `redline3d/src/render/lobby.ts`: delegate the existing remote-car seam to `remote-cars.ts`.
- `redline3d/src/ui/presence.ts`: live-count chip and spark button.
- `redline3d/src/ui/presence.test.ts`: visibility, count, offline, and tap behavior.
- `redline3d/src/main.ts`: identity and mode lifecycle, local pose source, roster resolver, callbacks.

---

### Task 1: Server Protocol and Pure Presence Room

**Files:**
- Create: `server/src/presence/protocol.test.ts`
- Create: `server/src/presence/protocol.ts`
- Create: `server/src/presence/room.test.ts`
- Create: `server/src/presence/room.ts`

**Interfaces:**
- Produces `parseClientMessage(raw: unknown): ClientMessage | null`.
- Produces `normalizePose(message: ClientPose): PresencePose`.
- Produces `makePresenceRoom(options?): PresenceRoom`.
- `PresenceRoom.join(userId, hello, sink)` returns `{ ok: true, id }` or `{ ok: false, code: "lobby_full" }`.
- `PresenceRoom.pose(id, pose, now)` and `.emote(id, now)` return a rate-limit result.
- `PresenceRoom.snapshot(serverTime)` returns a public `ServerSnapshot` with no private user ids.

- [ ] **Step 1: Write failing protocol tests**

Cover a valid hello, invalid name, unknown type, non-finite pose, coordinate clamps, heading normalization, speed clamp, and a car id longer than 64 characters.

```ts
it("normalizes a finite pose to lobby limits", () => {
  const parsed = parseClientMessage(JSON.stringify({
    type: "pose", x: 999, z: -999, heading: Math.PI * 3, speed: 999, carId: "Orion",
  }));
  expect(parsed?.type).toBe("pose");
  expect(normalizePose(parsed as ClientPose)).toEqual({
    x: 120, z: -160, heading: -Math.PI, speed: 48, carId: "Orion",
  });
});
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run: `cd server && npx vitest run src/presence/protocol.test.ts`

Expected: FAIL because `./protocol.js` does not exist.

- [ ] **Step 3: Implement the protocol parser and normalization**

Use Zod discriminated unions. Export exact constants `MAX_MESSAGE_BYTES = 2048`, `LOBBY_X = 120`, `LOBBY_Z_MIN = -160`, `LOBBY_Z_MAX = 160`, `MAX_LOBBY_SPEED = 48`, `NAME_RE = /^[a-z0-9_]{3,16}$/`, and `CAR_ID_RE = /^[\x20-\x7e]{1,64}$/`.

- [ ] **Step 4: Run the protocol test and verify GREEN**

Run: `cd server && npx vitest run src/presence/protocol.test.ts`

Expected: all protocol tests pass.

- [ ] **Step 5: Write failing room tests**

```ts
it("caps the room at eight while keeping public ids distinct", () => {
  const room = makePresenceRoom({ id: (() => { let n = 0; return () => `p${++n}`; })() });
  for (let i = 0; i < 8; i++) {
    expect(room.join("same-private-user", hello(`rider_${i}`), sink()).ok).toBe(true);
  }
  expect(room.join("ninth", hello("rider_9"), sink())).toEqual({ ok: false, code: "lobby_full" });
  expect(room.snapshot(10).players.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
  expect(JSON.stringify(room.snapshot(10))).not.toContain("same-private-user");
});
```

Also cover leave, pose clamps, 15 Hz pose rate limit, two-per-second emote limit, and emote broadcast nonce.

- [ ] **Step 6: Run the room test and verify RED**

Run: `cd server && npx vitest run src/presence/room.test.ts`

Expected: FAIL because `makePresenceRoom` does not exist.

- [ ] **Step 7: Implement the minimal pure room**

Store private `userId` only in the internal member record. Snapshot objects must be newly constructed from public fields. Use a one-second sliding counter per member for pose and emote limits. Do not start timers in this module.

- [ ] **Step 8: Run focused server tests and verify GREEN**

Run: `cd server && npx vitest run src/presence/protocol.test.ts src/presence/room.test.ts`

Expected: both files pass with no unhandled errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/presence/protocol.ts server/src/presence/protocol.test.ts server/src/presence/room.ts server/src/presence/room.test.ts
git commit -m "feat(server): add live paddock presence room"
```

### Task 2: Authenticated WebSocket Transport

**Files:**
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Create: `server/src/presence/socket.test.ts`
- Create: `server/src/presence/socket.ts`
- Modify: `server/src/http/server.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/test/harness.ts`

**Interfaces:**
- Consumes `PresenceRoom`, `SessionAuth.verifyToken`, and `Users.get`.
- Produces `registerPresenceSocket(server, deps): PresenceSocketGateway`.
- `PresenceSocketGateway.start()` starts the 100 ms snapshot and 15 second heartbeat timers.
- `PresenceSocketGateway.stop()` clears timers and terminates remaining sockets.

- [ ] **Step 1: Install the official Fastify WebSocket adapter**

Run:

```bash
cd server
npm install @fastify/websocket@^11.3.0
npm install --save-dev @types/ws@^8.18.1
```

Expected: `server/package.json` and `server/package-lock.json` contain the new dependency entries.

- [ ] **Step 2: Write failing socket integration tests**

Use `await server.ready()` and `await server.injectWS("/v1/presence")`. Register the message listener before sending, and terminate each client during cleanup.

```ts
it("authenticates in the first frame without URL credentials", async () => {
  const { token } = await ctx.sessionAuth.issueAnonymous();
  const ws = await ctx.server.injectWS("/v1/presence");
  expect(ws.url).not.toContain(token);
  const welcome = nextJson(ws);
  ws.send(JSON.stringify({ type: "hello", token, name: "alice_1", carId: "Orion" }));
  await expect(welcome).resolves.toMatchObject({ type: "welcome", id: expect.any(String) });
  ws.terminate();
});
```

Add invalid token, full room, pose snapshot, close cleanup, pre-hello pose, and hello timeout cases. Inject `now`, timer functions, and heartbeat interval where deterministic control is needed.

- [ ] **Step 3: Run the socket tests and verify RED**

Run: `cd server && npx vitest run src/presence/socket.test.ts`

Expected: FAIL because the WebSocket route is not registered.

- [ ] **Step 4: Implement the socket gateway**

Register `@fastify/websocket` before every route with `{ options: { maxPayload: 2048, perMessageDeflate: false } }`. Attach `message`, `close`, `error`, and `pong` handlers synchronously. Require hello within five seconds, verify the token and user, join the room, send welcome, and remove membership on any close path. Catch errors inside message handlers because Fastify HTTP error handlers do not handle established socket message failures.

- [ ] **Step 5: Add snapshot and heartbeat lifecycle**

Every 100 ms, call `room.broadcastSnapshot(now())`. Every 15 seconds, terminate a socket that did not answer the previous ping. Register gateway shutdown in Fastify's `onClose` hook so tests and production do not leak timers.

- [ ] **Step 6: Run focused tests and build**

Run:

```bash
cd server
npx vitest run src/presence/protocol.test.ts src/presence/room.test.ts src/presence/socket.test.ts
npm run build
```

Expected: focused tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/presence/socket.ts server/src/presence/socket.test.ts server/src/http/server.ts server/src/index.ts server/src/test/harness.ts
git commit -m "feat(server): stream authenticated paddock presence"
```

### Task 3: Pure Remote Motion

**Files:**
- Create: `redline3d/src/core/remote-motion.test.ts`
- Create: `redline3d/src/core/remote-motion.ts`

**Interfaces:**
- Produces `smoothRemote(current, target, dt): RemotePose`.
- Produces `shortestAngleDelta(from, to): number`.
- Snaps when planar distance exceeds `REMOTE_SNAP_DISTANCE = 30`.

- [ ] **Step 1: Write failing motion tests**

```ts
it("takes the shortest path across the PI boundary", () => {
  const next = smoothRemote(
    { x: 0, z: 0, heading: Math.PI - 0.05, speed: 1 },
    { x: 0, z: 0, heading: -Math.PI + 0.05, speed: 1 },
    1 / 60,
  );
  expect(Math.abs(shortestAngleDelta(Math.PI - 0.05, next.heading))).toBeLessThan(0.05);
});
```

Also compare one 1/30 step with two 1/60 steps, test convergence, and test a 31-unit snap.

- [ ] **Step 2: Run and verify RED**

Run: `cd redline3d && npx vitest run src/core/remote-motion.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement minimal exponential smoothing**

Use `alpha = 1 - Math.exp(-12 * dt)` for position, speed, and heading delta. Normalize the final angle to `[-PI, PI]`.

- [ ] **Step 4: Run and verify GREEN**

Run: `cd redline3d && npx vitest run src/core/remote-motion.test.ts`

Expected: all motion tests pass.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/remote-motion.ts redline3d/src/core/remote-motion.test.ts
git commit -m "feat(client): smooth remote paddock motion"
```

### Task 4: Reconnecting Browser Presence Client

**Files:**
- Create: `redline3d/src/core/presence.test.ts`
- Create: `redline3d/src/core/presence.ts`

**Interfaces:**
- Consumes existing `AuthProvider.authHeaders()`.
- Produces `apiBaseToWebSocket(baseUrl): string`.
- Produces `createPresenceClient(options): PresenceClient` with `connect()`, `disconnect()`, `updatePose(pose)`, `emote()`, and `status()`.
- Emits `onSnapshot(players, localId)`, `onJoin(player)`, `onLeave(player)`, `onEmote(event)`, and `onStatus(status, count)`.

- [ ] **Step 1: Write a fake WebSocket and failing lifecycle tests**

The fake records constructor URL and sent frames, exposes `open()`, `message(value)`, and `close()`, and supports event listeners.

```ts
it("sends auth in hello, never in the URL", async () => {
  const client = createPresenceClient({
    baseUrl: "https://api.example.com",
    auth: fakeAuth("SECRET"),
    WebSocket: FakeWebSocket as never,
    name: () => "alice_1",
    carId: () => "Orion",
  });
  client.connect();
  await flush();
  const ws = FakeWebSocket.only();
  expect(ws.url).toBe("wss://api.example.com/v1/presence");
  expect(ws.url).not.toContain("SECRET");
  ws.open();
  expect(JSON.parse(ws.sent[0])).toEqual({ type: "hello", token: "SECRET", name: "alice_1", carId: "Orion" });
});
```

Add 100 ms pose throttle, malformed snapshot atomic rejection, local-player filtering, join/leave diff, emote event, reconnect delays 500/1000/2000/5000, welcome reset, and manual disconnect cancellation.

- [ ] **Step 2: Run and verify RED**

Run: `cd redline3d && npx vitest run src/core/presence.test.ts`

Expected: FAIL because `createPresenceClient` does not exist.

- [ ] **Step 3: Implement the client state machine**

Read the bearer token from `authorization: Bearer ...` immediately before constructing the socket. Parse every server message into a complete validated object before changing client state. Keep reconnect timers and socket generations so stale close events cannot reconnect an intentionally closed client.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd redline3d && npx vitest run src/core/presence.test.ts src/core/remote-motion.test.ts`

Expected: both test files pass.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/presence.ts redline3d/src/core/presence.test.ts
git commit -m "feat(client): connect to live paddock presence"
```

### Task 5: Remote Cars, Names, and Spark Pulse

**Files:**
- Create: `redline3d/src/render/remote-cars.test.ts`
- Create: `redline3d/src/render/remote-cars.ts`
- Modify: `redline3d/src/render/lobby.ts`

**Interfaces:**
- Consumes `RemotePresencePlayer` and a roster resolver `(carId) => { url, scale, yaw } | null`.
- Produces `createRemoteCars(resolver, deps?): RemoteCars` with `group`, `setTargets(players)`, `emote(event)`, `update(dt)`, `clear()`, and `dispose()`.
- Extends lobby `RemoteCarState` with `name`, `carId`, and `speed`; spark nonce remains on the separate emote event.

- [ ] **Step 1: Write failing registry lifecycle tests**

Inject a fake `makeCar` that records `setModel`, `update`, and disposal, plus a fake nameplate factory.

```ts
it("keeps identity stable while changing the equipped model", () => {
  const remotes = createRemoteCars(resolveCar, fakeDeps());
  remotes.setTargets([player({ id: "p1", carId: "Orion" })]);
  remotes.setTargets([player({ id: "p1", carId: "Banana" })]);
  expect(fakeCars).toHaveLength(1);
  expect(fakeCars[0].setModel).toHaveBeenLastCalledWith("/models/banana.glb", undefined, Math.PI / 2);
});
```

Also cover one instance per id, nameplate text, smooth update, removal disposal, clear, unknown-car fallback, and one pulse per emote nonce.

- [ ] **Step 2: Run and verify RED**

Run: `cd redline3d && npx vitest run src/render/remote-cars.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement remote cars**

Reuse `createCar` and `tagTexture`. Add each car group, name sprite, and a small additive spark sprite to one anchor group. Update the anchor from `smoothRemote`, spin wheels through `car.update(dt, speed)`, and remove every resource when the player leaves. Unknown car ids keep the immediate procedural fallback and never become a URL.

- [ ] **Step 4: Replace lobby's debug boxes with the registry**

Construct `RemoteCars` inside `createLobby`, delegate `setRemoteCars`, advance it in `lobby.update(dt)`, and dispose it in `lobby.dispose()`.

- [ ] **Step 5: Run renderer and lobby tests**

Run:

```bash
cd redline3d
npx vitest run src/render/remote-cars.test.ts src/core/lobby-layout.test.ts src/ui/lobbyhud.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/render/remote-cars.ts redline3d/src/render/remote-cars.test.ts redline3d/src/render/lobby.ts
git commit -m "feat(client): render live paddock drivers"
```

### Task 6: Presence HUD

**Files:**
- Create: `redline3d/src/ui/presence.test.ts`
- Create: `redline3d/src/ui/presence.ts`

**Interfaces:**
- Produces `createPresenceHud(parent, onEmote): PresenceHud`.
- `PresenceHud.setVisible(boolean)`, `.setState("offline" | "connecting" | "live", count)`, and `.pulse()`.

- [ ] **Step 1: Write failing DOM-stub tests**

Follow the hand-rolled DOM pattern in `ui/lobbyhud.test.ts`.

```ts
it("shows LIVE 2 and dispatches the spark button once", () => {
  const onEmote = vi.fn();
  const hud = createPresenceHud(parent as never, onEmote);
  hud.setVisible(true);
  hud.setState("live", 2);
  expect(find("live-count").textContent).toBe("LIVE 2");
  find("live-emote").onclick?.();
  expect(onEmote).toHaveBeenCalledTimes(1);
});
```

Also cover hidden outside lobby, `LIVE OFFLINE`, `CONNECTING`, and local pulse feedback.

- [ ] **Step 2: Run and verify RED**

Run: `cd redline3d && npx vitest run src/ui/presence.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal HUD**

Use the existing Chakra Petch visual language, safe-area insets, pointer events only on the emote button, and no emoji text beyond the single `⚡` glyph.

- [ ] **Step 4: Run and verify GREEN**

Run: `cd redline3d && npx vitest run src/ui/presence.test.ts`

Expected: all presence HUD tests pass.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/ui/presence.ts redline3d/src/ui/presence.test.ts
git commit -m "feat(ui): add live paddock presence controls"
```

### Task 7: Wire Presence Into the Existing Game Loop

**Files:**
- Modify: `redline3d/src/main.ts`
- Create: `redline3d/src/core/presence-lifecycle.ts`
- Create: `redline3d/src/core/presence-lifecycle.test.ts`
- Modify: `redline3d/src/core/menu-visibility.test.ts` only if the new button needs explicit overlay gating.
- Modify: `server/README.md`
- Modify: `redline3d/BUILD_APK.md` only if deployed WebSocket configuration needs a documented variable.

**Interfaces:**
- Consumes `createPresenceClient`, `createPresenceHud`, `Lobby.setRemoteCars`, `identity`, `equippedCar`, and lobby `drive` state.
- No new exported game-wide interface.

- [ ] **Step 1: Add a failing wiring guard in `presence-lifecycle.test.ts`**

Define the expected pure lifecycle behavior without importing `main.ts`:

```ts
expect(presenceShouldConnect({ mode: "lobby", hasIdentity: true })).toBe(true);
expect(presenceShouldConnect({ mode: "race", hasIdentity: true })).toBe(false);
expect(presenceShouldConnect({ mode: "lobby", hasIdentity: false })).toBe(false);
```

- [ ] **Step 2: Run and verify RED**

Run the exact focused test containing the lifecycle helper.

Expected: FAIL because the helper or behavior does not exist.

- [ ] **Step 3: Wire identity and mode lifecycle**

Declare the nullable identity before lobby entry functions so the initial `enterLobby()` can safely remain offline. Connect after guest selection, successful account sign-in, or returning-identity boot. Disconnect on race, highway, garage, logout, and page teardown. Re-entering the lobby reconnects immediately.

- [ ] **Step 4: Wire local and remote frame data**

In the lobby frame branch, send `{ x: drive.x, z: drive.z, heading: -drive.heading, speed: Math.abs(drive.speed), carId: equippedCar.name }` through the client's 10 Hz throttle. Feed remote snapshots into `lobby.setRemoteCars`, excluding the local public id. Resolve car ids only through `CAR_DEFS`.

- [ ] **Step 5: Wire feedback**

Update `LIVE N` from client status, show messages such as `"alice_1 rolled in"` and `"alice_1 rolled out"` through `lobbyHud.toast`, and forward spark events to the remote-car renderer. The local spark button calls `presence.emote()` and pulses immediately.

- [ ] **Step 6: Document local and deployed requirements**

Document that the same `VITE_API_BASE` host serves HTTP and WebSocket, with `http/https` converted to `ws/wss`; no extra public environment variable is required. Note that reverse proxies must allow WebSocket upgrades on `/v1/presence`.

- [ ] **Step 7: Run focused tests and builds**

Run:

```bash
cd redline3d
npx vitest run src/core/presence.test.ts src/core/remote-motion.test.ts src/render/remote-cars.test.ts src/ui/presence.test.ts
npm run build
cd ../server
npx vitest run src/presence/protocol.test.ts src/presence/room.test.ts src/presence/socket.test.ts
npm run build
```

Expected: all focused tests pass and both TypeScript builds exit 0.

- [ ] **Step 8: Commit**

```bash
git add redline3d/src/main.ts redline3d/src/core/presence-lifecycle.ts redline3d/src/core/presence-lifecycle.test.ts server/README.md redline3d/BUILD_APK.md
git commit -m "feat: open the live multiplayer paddock"
```

### Task 8: Full Verification and Demo Proof

**Files:**
- Modify only files required by verified failures.

- [ ] **Step 1: Run all automated verification sequentially**

```bash
cd redline3d && npm test && npm run build
cd ../server && npm test && npm run build
cd ../packages/engine && npm test
```

Expected: client, server, and engine suites pass; both production builds exit 0.

- [ ] **Step 2: Run a two-client local smoke test**

Start the server and client, open two browser contexts with distinct local storage, choose different names, and verify:

- both show `LIVE 2`;
- each sees the other's name and motion;
- a car change is mirrored after returning to the lobby;
- spark appears remotely;
- closing one context removes it from the other;
- stopping the server leaves solo driving usable.

- [ ] **Step 3: Inspect final diff and protocol privacy**

Run:

```bash
git diff main...HEAD --check
git diff --stat main...HEAD
rg -n "wallet|balance|stake|payout" server/src/presence redline3d/src/core/presence.ts
```

Expected: no whitespace errors; no presence payload field exposes financial or wallet data.

- [ ] **Step 4: Request code review and address every critical or important finding**

Review against the design spec at `docs/superpowers/specs/2026-07-11-live-paddock-multiplayer-design.md`, then rerun affected tests after corrections.

- [ ] **Step 5: Commit review corrections if any**

```bash
git add server/src/presence server/src/http/server.ts server/src/index.ts server/src/test/harness.ts server/package.json server/package-lock.json redline3d/src/core/presence.ts redline3d/src/core/presence-lifecycle.ts redline3d/src/render/remote-cars.ts redline3d/src/render/lobby.ts redline3d/src/ui/presence.ts redline3d/src/main.ts
git commit -m "fix: harden live paddock multiplayer"
```

- [ ] **Step 6: Merge into main only after fresh full verification**

Use a fast-forward merge when possible. Do not push unless the user separately requests publishing.
