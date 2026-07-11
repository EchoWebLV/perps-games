# Live Paddock Multiplayer Design

**Date:** 2026-07-11

**Status:** Approved for implementation

**Scope:** Add a small, reliable realtime presence layer to the existing drivable lobby so judges can open the game on two mobile devices and immediately see both players.

## Goal

Turn the town-square lobby into a live paddock where up to eight players can see one another drive, identify each other by name and equipped car, and exchange one lightweight visual emote.

The feature exists to create a fast, legible hackathon demo moment. It is not a general multiplayer framework and does not change the on-chain race, wallet, settlement, economy, or collision model.

## Player Experience

1. A player chooses a guest name or signs in through the existing identity gate.
2. Entering the lobby opens a realtime presence connection in the background.
3. A `LIVE N` chip shows the number of connected paddock players, including the local player.
4. Other connected players appear as their equipped car with a floating driver name.
5. Remote cars move smoothly instead of jumping between network samples.
6. A brief lobby toast announces when another driver arrives or leaves.
7. A small `⚡` emote button sends a visible pulse above the player's car. Other clients see the same pulse.
8. Leaving the lobby or closing the app removes the car promptly. Broken connections disappear after the server heartbeat timeout.

The local player never sees their own duplicate remote car.

## Deliberate Limits

- One global paddock room, capped at eight concurrent socket connections.
- No chat, voice, friends, parties, invitations, matchmaking, or player-to-player collisions.
- No shared race simulation and no ability to influence another player's position or trade.
- No persistence. Presence lives only in server memory and disappears on restart.
- No wallet addresses, balances, stakes, or trade outcomes are sent through presence.
- No MagicBlock state migration. The existing MagicBlock round remains the product's on-chain realtime system.
- No new player economy rewards for connecting or emoting.

## Architecture

```text
Existing session token
        |
        v
Fastify WebSocket route
        |
        v
In-memory PresenceRoom (max 8)
        |
        +---- validated pose snapshots at 10 Hz ----> browser clients
        +---- emote events ------------------------> browser clients
                                                      |
                                                      v
                                         interpolated remote-car renderer
```

### Server boundaries

`server/src/presence/protocol.ts` owns the wire message types and runtime parsing limits.

`server/src/presence/room.ts` owns membership, capacity, the latest validated pose for each connection, snapshot generation, and emote fan-out. It has no Fastify or WebSocket dependency and is unit-testable with in-memory sinks.

`server/src/presence/socket.ts` adapts a Fastify WebSocket connection to `PresenceRoom`. It requires the first client message to be `hello`, verifies the existing session token, applies a short authentication timeout, handles heartbeat cleanup, and never places credentials in a URL.

`server/src/http/server.ts` registers `@fastify/websocket` before the route tree and exposes `/v1/presence` as the only new realtime route.

### Client boundaries

`redline3d/src/core/presence.ts` owns the WebSocket lifecycle, protocol parsing, reconnect backoff, 10 Hz outbound pose throttling, current remote snapshot, and join/leave detection. It takes the existing `AuthProvider` and an injectable WebSocket constructor for tests.

`redline3d/src/core/remote-motion.ts` is a small pure interpolation unit. It keeps a target pose per remote player and advances displayed position and heading with frame-rate-independent smoothing, including shortest-path angle interpolation.

`redline3d/src/render/remote-cars.ts` owns remote car instances and nameplates. It reuses `createCar` for an immediate procedural fallback and eventual real GLB, maps the server's `carId` through the existing client roster, and disposes removed players.

`redline3d/src/ui/presence.ts` owns the `LIVE N` chip and the `⚡` emote button. It is visible only in the lobby and contains no network logic.

`redline3d/src/main.ts` supplies the local pose, identity name, and equipped car; switches presence between active and inactive with the lobby mode; forwards snapshots to the remote renderer; and uses the existing lobby toast for arrival and departure feedback.

## Protocol

All messages are JSON objects smaller than 2 KiB. Unknown, malformed, oversized, or out-of-order messages are rejected without mutating room state.

### Client to server

The first message must arrive within five seconds:

```ts
type ClientHello = {
  type: "hello";
  token: string;
  name: string;   // normalized 3-16 lowercase [a-z0-9_]
  carId: string;  // 1-64 printable characters
};
```

After successful authentication:

```ts
type ClientPose = {
  type: "pose";
  x: number;       // clamped to the lobby bounds
  z: number;       // clamped to the lobby bounds
  heading: number; // normalized to [-PI, PI]
  speed: number;   // clamped to [0, lobby maximum]
  carId: string;   // permits an equipped-car change without reconnecting
};

type ClientEmote = {
  type: "emote";
  kind: "spark";
};
```

The client sends pose updates at no more than 10 Hz. The server also rate-limits accepted pose and emote messages so a modified client cannot turn the room into an unbounded broadcast source.

### Server to client

```ts
type ServerWelcome = {
  type: "welcome";
  id: string;       // random public connection id, never the database user id
  serverTime: number;
};

type PresencePlayer = {
  id: string;
  name: string;
  carId: string;
  x: number;
  z: number;
  heading: number;
  speed: number;
};

type ServerSnapshot = {
  type: "snapshot";
  players: PresencePlayer[];
  serverTime: number;
};

type ServerEmote = {
  type: "emote";
  id: string;
  kind: "spark";
  nonce: number;
};

type ServerError = {
  type: "error";
  code: "unauthorized" | "lobby_full" | "bad_message" | "rate_limited";
};
```

Snapshots contain the complete current room because the room has at most eight players. This keeps reconnect and dropped-message behavior simple and deterministic.

## Authentication and Privacy

- The browser opens the socket without query credentials.
- The first WebSocket frame contains the existing session token and identity display name.
- The server calls `SessionAuth.verifyToken`, verifies that the user still exists, and then assigns a random public connection id.
- Anonymous guest sessions are allowed because the feature is social presence, not an economy mutation.
- Database user ids and wallet addresses never leave the server through this protocol.
- A second device using the same account receives its own connection id instead of evicting the first device.

## Validation and Abuse Limits

- Maximum eight authenticated connections.
- Five-second hello timeout.
- Maximum 2 KiB message payload.
- Driver names use the same 3-16 character format as the identity gate.
- Coordinates are finite numbers clamped to the real lobby bounds.
- Heading is normalized; speed is clamped.
- Pose accepts at most 15 updates per second, allowing harmless scheduling jitter above the client's 10 Hz target.
- Emotes accept at most two events per second per connection.
- The server sends ping frames and terminates clients that fail the heartbeat.
- A malformed authenticated message produces `bad_message`; repeated abuse closes the socket.

These controls protect service availability. They are not anti-cheat because remote poses are visual-only and cannot affect money or other players.

## Rendering and Motion

Each network snapshot updates a target pose. The renderer approaches the target with frame-rate-independent exponential smoothing and shortest-path heading interpolation. A large discontinuity, such as a reconnect or server correction beyond 30 world units, snaps to the target instead of visibly crossing the map.

Remote cars:

- render an immediate lightweight placeholder;
- load the matching existing GLB through the browser cache;
- show a floating nameplate using the existing `tagTexture` visual language;
- spin wheels from the reported speed;
- remain non-collidable and never enter the local driving physics;
- show a short cyan/pink spark pulse when an emote event arrives.

Reduced-quality devices still show every player, but may retain placeholders instead of decoding additional remote GLBs when the device quality tier is `low`.

## Connection Lifecycle

- Presence starts only after an identity exists.
- The socket connects while the player is in the lobby.
- Leaving the lobby closes the socket cleanly and clears remote cars.
- Unexpected disconnects reconnect with backoff of 0.5, 1, 2, then 5 seconds, capped at 5 seconds.
- Re-entering the lobby reconnects immediately rather than waiting for an old backoff.
- The `LIVE` chip shows a disconnected state until the welcome frame arrives.
- Presence failures never block driving, menus, practice rounds, wallet operations, or on-chain play.

## Failure Behavior

- Server unavailable: the lobby remains fully playable solo; the chip reads `LIVE OFFLINE`.
- Invalid or expired token: clear remote players, close the socket, and let the existing auth flow refresh on the next lobby entry.
- Lobby full: remain solo and show `Paddock full` once.
- Bad remote car id: use the procedural fallback instead of fetching an arbitrary URL.
- GLB load failure: retain the placeholder and nameplate.
- Snapshot with invalid data: ignore the entire message.
- App backgrounded: the socket may close; normal reconnect restores a full snapshot on return.

## Testing

### Server unit tests

- Room admits up to eight connections and rejects the ninth.
- Room assigns distinct public ids even when two sockets authenticate as the same user.
- Pose validation clamps lobby coordinates, heading, speed, and car id.
- Snapshot excludes private user ids and includes all current public players.
- Leaving removes a player from the next snapshot.
- Pose and emote rate limits reject excess messages.
- Malformed or pre-hello messages never mutate room state.

### Server transport tests

- Valid first-message authentication receives `welcome` and a snapshot.
- Missing, expired, or invalid token receives `unauthorized` and closes.
- No hello within five seconds closes.
- Socket close removes room membership.
- Heartbeat termination removes dead membership.

### Client unit tests

- HTTP API URLs convert to `ws:` or `wss:` correctly.
- Authentication is sent in the first frame, not the URL.
- Pose sends are throttled to 10 Hz.
- Snapshot parsing rejects malformed payloads atomically.
- Join and leave diffs ignore the local public id.
- Reconnect backoff caps at five seconds and resets after welcome.
- Leaving lobby cancels reconnect and clears remote state.
- Motion interpolation is frame-rate independent, handles wrapped angles, and snaps large gaps.

### Renderer and UI tests

- Remote players create one car and nameplate each.
- A car id change updates the model without recreating the public identity.
- Removed players are disposed.
- Emote nonce changes trigger one pulse.
- `LIVE N`, offline state, and emote-button visibility follow lobby connection state.

### Manual demo verification

1. Open the deployed game on a Seeker and a desktop browser with different names.
2. Enter the lobby on both and confirm `LIVE 2`.
3. Drive both cars and confirm smooth mirrored motion and correct names.
4. Equip a different car, return to the lobby, and confirm the other device sees it.
5. Trigger the spark emote from each device.
6. Close one app and confirm the other removes it promptly.
7. Start a practice or on-chain race and confirm presence has not altered settlement behavior.

## Success Criteria

1. Two mobile-capable clients can enter the same lobby and see each other within two seconds on a normal network.
2. Remote motion is smooth enough to read as another driver rather than a debug marker.
3. Driver names and equipped cars are legible in the lobby.
4. Join, leave, player count, and the spark emote are visible without opening a menu.
5. A failed presence service degrades to the existing solo lobby without blocking any game function.
6. No presence message exposes or changes wallet, balance, stake, settlement, inventory ownership, or trade data.
7. Existing client, server, and engine test suites and production builds remain green.

