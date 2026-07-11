# Lobby First-Load Fidelity and Emote Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reveal the lobby only after the local car reaches a bounded model outcome, center the live count, and add typed `😂`, `🔥`, and `💀` multiplayer emotes beneath the hamburger.

**Architecture:** A pure boot-reveal controller owns the 20-second splash deadline while `createCar` reports loaded or failed model outcomes. Presence transports a closed emote-kind union through server validation, room broadcast, client decoding, HUD dispatch, and a reusable remote-car emoji visual. The status chip and emote rail are separate HUD children so centering and menu-relative positioning do not interfere.

**Tech Stack:** TypeScript, Three.js, Fastify WebSocket, Zod, Vitest, Vite, hand-rolled DOM test doubles.

## Global Constraints

- Emotes are exactly `😂` laugh, `🔥` fire, and `💀` skull, in that order.
- The local car controls the normal splash reveal; remote GLBs never block startup.
- Reveal timeout is exactly 20,000ms.
- Model or presence failure must never block local driving.
- `LIVE N` is horizontally centered in the top safe area.
- The emote rail is below the 42px hamburger with an 8px gap and remains safe-area aware.
- Presence payloads remain visual-only and contain no wallet, balance, stake, or payout fields.
- Existing two-emotes-per-second server rate limiting remains unchanged.
- Do not add chat, history, unlocks, cooldown UI, collision, or gameplay effects.
- User-facing copy must not use em dashes.

---

## File Map

- Create `redline3d/src/core/boot-reveal.ts`: pure idempotent loaded/failed/timeout reveal controller.
- Create `redline3d/src/core/boot-reveal.test.ts`: fake-timer coverage for all reveal outcomes.
- Modify `redline3d/src/render/car.ts`: report first model outcome and neutralize the procedural fallback.
- Modify `redline3d/src/render/car.test.ts`: loaded, failed, stale, and fallback-material coverage.
- Modify `redline3d/src/main.ts`: wire reveal controller and typed emote callback.
- Modify `redline3d/index.html`: remove the competing nine-second splash timeout and add landscape rail positioning.
- Modify `server/src/presence/protocol.ts`: closed emote-kind schema and shared type.
- Modify `server/src/presence/protocol.test.ts`: accepted and rejected emote kind coverage.
- Modify `server/src/presence/room.ts`: preserve selected kind in broadcast.
- Modify `server/src/presence/room.test.ts`: kind and rate-limit coverage.
- Modify `server/src/presence/socket.ts`: forward the parsed kind into the room.
- Modify `server/src/presence/socket.test.ts`: end-to-end WebSocket kind preservation.
- Modify `redline3d/src/core/presence.ts`: typed emote encoding and decoding.
- Modify `redline3d/src/core/presence.test.ts`: all kinds, malformed kind, and send-failure coverage.
- Modify `redline3d/src/ui/presence.ts`: centered status and three-button vertical rail.
- Modify `redline3d/src/ui/presence.test.ts`: layout, ordering, accessibility, and input dispatch.
- Modify `redline3d/src/render/remote-cars.ts`: reusable typed emoji visual with shared textures.
- Modify `redline3d/src/render/remote-cars.test.ts`: kind selection, nonce, animation, and disposal.

---

### Task 1: Bounded First-Load Reveal

**Files:**
- Create: `redline3d/src/core/boot-reveal.ts`
- Create: `redline3d/src/core/boot-reveal.test.ts`
- Modify: `redline3d/src/render/car.ts`
- Modify: `redline3d/src/render/car.test.ts`
- Modify: `redline3d/src/main.ts:120-145`
- Modify: `redline3d/index.html:166-195`

**Interfaces:**
- Produces: `type ModelLoadOutcome = "loaded" | "failed"` from `core/boot-reveal.ts`.
- Produces: `createBootReveal(options): { modelSettled(outcome: ModelLoadOutcome): void; dispose(): void }`.
- Changes: `createCar(onReady?: (outcome: ModelLoadOutcome) => void, options?: CarOptions): Car`.

- [ ] **Step 1: Write the failing boot-reveal tests**

Create `redline3d/src/core/boot-reveal.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBootReveal } from "./boot-reveal";

describe("createBootReveal", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["loaded", "failed"] as const)("reveals once for %s", (outcome) => {
    vi.useFakeTimers();
    const reveal = vi.fn();
    const gate = createBootReveal({ reveal, timeoutMs: 20_000 });
    gate.modelSettled(outcome);
    gate.modelSettled(outcome);
    vi.advanceTimersByTime(20_000);
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(outcome);
  });

  it("reveals a timed-out fallback at exactly 20 seconds", () => {
    vi.useFakeTimers();
    const reveal = vi.fn();
    createBootReveal({ reveal, timeoutMs: 20_000 });
    vi.advanceTimersByTime(19_999);
    expect(reveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reveal).toHaveBeenCalledWith("timed_out");
  });
});
```

- [ ] **Step 2: Run the boot-reveal test to verify RED**

Run: `cd redline3d && npx vitest run src/core/boot-reveal.test.ts`

Expected: FAIL because `./boot-reveal` does not exist.

- [ ] **Step 3: Implement the pure reveal controller**

Create `redline3d/src/core/boot-reveal.ts`:

```ts
export type ModelLoadOutcome = "loaded" | "failed";
export type BootRevealOutcome = ModelLoadOutcome | "timed_out";

export function createBootReveal(options: {
  reveal(outcome: BootRevealOutcome): void;
  timeoutMs: number;
}) {
  let settled = false;
  const timer = setTimeout(() => settle("timed_out"), options.timeoutMs);
  function settle(outcome: BootRevealOutcome) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.reveal(outcome);
  }
  return {
    modelSettled: (outcome: ModelLoadOutcome) => settle(outcome),
    dispose: () => { settled = true; clearTimeout(timer); },
  };
}
```

- [ ] **Step 4: Run boot-reveal tests to verify GREEN**

Run: `cd redline3d && npx vitest run src/core/boot-reveal.test.ts`

Expected: 3 tests PASS.

- [ ] **Step 5: Write failing car outcome and neutral-fallback tests**

Extend `redline3d/src/render/car.test.ts`:

```ts
it("reports the first successful current model as loaded once", () => {
  const settled = vi.fn();
  createCar(settled);
  pending[0].succeed(modelFixture().gltf);
  expect(settled).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledWith("loaded");
});

it("reports a current first-model failure once", () => {
  const settled = vi.fn();
  createCar(settled);
  pending[0].fail(new Error("cold load failed"));
  expect(settled).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledWith("failed");
});

it("does not settle from a stale model callback", () => {
  const settled = vi.fn();
  const car = createCar(settled, { loadDefault: false });
  car.setModel("/models/old.glb");
  car.setModel("/models/new.glb");
  pending[0].succeed(modelFixture().gltf);
  expect(settled).not.toHaveBeenCalled();
  pending[1].succeed(modelFixture().gltf);
  expect(settled).toHaveBeenCalledWith("loaded");
});

it("uses a neutral rough fallback body before a GLB arrives", () => {
  const car = createCar(undefined, { loadDefault: false });
  const placeholder = car.group.children[0] as THREE.Group;
  const body = placeholder.children[0] as THREE.Mesh;
  const material = body.material as THREE.MeshStandardMaterial;
  expect(material.color.getHexString()).toBe("b5bbc4");
  expect(material.metalness).toBe(0.4);
  expect(material.roughness).toBe(0.76);
  expect(material.emissive.getHexString()).toBe("59616d");
  expect(material.emissiveIntensity).toBe(0.32);
});
```

- [ ] **Step 6: Run car tests to verify RED**

Run: `cd redline3d && npx vitest run src/render/car.test.ts`

Expected: FAIL because callbacks have no outcome and fallback materials retain the current reflective values.

- [ ] **Step 7: Implement car outcomes and neutral fallback**

In `redline3d/src/render/car.ts`:

```ts
import type { ModelLoadOutcome } from "../core/boot-reveal";

export function createCar(onReady?: (outcome: ModelLoadOutcome) => void, options: CarOptions = {}): Car {
  let readinessSettled = false;
  const settleReadiness = (outcome: ModelLoadOutcome) => {
    if (readinessSettled) return;
    readinessSettled = true;
    onReady?.(outcome);
  };
  // Keep the fallback neutral under the lobby's pink directional light.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: "#b5bbc4", metalness: 0.4, roughness: 0.76,
    emissive: "#59616d", emissiveIntensity: 0.32,
  });
  // In applyTint(), preserve neutral idle fallback emissive:
  if (modelMats) {
    const intensity = phaseS === "idle" ? 0.03 : 0.06;
    for (const material of modelMats) {
      material.emissive.set(col);
      material.emissiveIntensity = intensity;
    }
  } else {
    bodyMat.emissive.set(phaseS === "idle" ? "#59616d" : col);
    bodyMat.emissiveIntensity = phaseS === "idle" ? 0.32 : 0.22;
    accentMat.emissive.set(col);
  }
  // At the end of the accepted current onLoad callback:
  settleReadiness("loaded");
  // Use this complete current-generation onError callback:
  (error) => {
    if (disposed || gen !== loadGen) return;
    lastReq = "";
    console.warn("[car] GLB failed to load:", url, error);
    settleReadiness("failed");
  };
}
```

Keep stale-generation and disposed callbacks unable to call `settleReadiness`.

- [ ] **Step 8: Wire the 20-second reveal and remove the nine-second competitor**

In `redline3d/src/main.ts`, create the gate before the car:

```ts
import { createBootReveal } from "./core/boot-reveal";

const bootReveal = createBootReveal({
  timeoutMs: 20_000,
  reveal: () => (window as Window & { hideSplash?: () => void }).hideSplash?.(),
});
const car = createCar((outcome) => bootReveal.modelSettled(outcome));
```

In `redline3d/index.html`, delete only:

```js
setTimeout(function () { window.hideSplash(); }, 9000);
```

Preserve `hideSplash()` idempotence and its 1.3-second minimum display time.

- [ ] **Step 9: Verify Task 1 and commit**

Run:

```bash
cd redline3d
npx vitest run src/core/boot-reveal.test.ts src/render/car.test.ts
npm run build
```

Expected: focused tests PASS and production build exits 0.

Commit:

```bash
git add redline3d/src/core/boot-reveal.ts redline3d/src/core/boot-reveal.test.ts redline3d/src/render/car.ts redline3d/src/render/car.test.ts redline3d/src/main.ts redline3d/index.html
git commit -m "fix: gate first lobby reveal on car readiness"
```

---

### Task 2: Typed Server Emote Protocol

**Files:**
- Modify: `server/src/presence/protocol.ts`
- Modify: `server/src/presence/protocol.test.ts`
- Modify: `server/src/presence/room.ts`
- Modify: `server/src/presence/room.test.ts`
- Modify: `server/src/presence/socket.ts`
- Modify: `server/src/presence/socket.test.ts`

**Interfaces:**
- Produces: `type PresenceEmoteKind = "laugh" | "fire" | "skull"`.
- Changes: `PresenceRoom.emote(id: string, kind: PresenceEmoteKind, now: number): RateLimitResult`.

- [ ] **Step 1: Write failing protocol tests for the closed union**

Add to `server/src/presence/protocol.test.ts`:

```ts
it.each(["laugh", "fire", "skull"] as const)("parses the %s emote", (kind) => {
  expect(parseClientMessage(JSON.stringify({ type: "emote", kind }))).toEqual({ type: "emote", kind });
});

it("rejects legacy and unknown emotes", () => {
  expect(parseClientMessage(JSON.stringify({ type: "emote", kind: "spark" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "emote", kind: "wave" }))).toBeNull();
});
```

- [ ] **Step 2: Run protocol tests to verify RED**

Run: `cd server && npx vitest run src/presence/protocol.test.ts`

Expected: the three accepted-kind cases FAIL.

- [ ] **Step 3: Implement the server emote union**

In `server/src/presence/protocol.ts`:

```ts
export const PRESENCE_EMOTE_KINDS = ["laugh", "fire", "skull"] as const;
export type PresenceEmoteKind = (typeof PRESENCE_EMOTE_KINDS)[number];
const emoteKindSchema = z.enum(PRESENCE_EMOTE_KINDS);

// In clientMessageSchema:
z.object({ type: z.literal("emote"), kind: emoteKindSchema }).strict()

// In ServerEmote:
kind: PresenceEmoteKind;
```

- [ ] **Step 4: Write failing room and socket preservation tests**

Update `server/src/presence/room.test.ts` to call:

```ts
room.emote(first.id, "laugh", 0);
room.emote(second.id, "skull", 1_000);
expect(firstSink.messages).toEqual([
  { type: "emote", id: "p1", kind: "laugh", nonce: 1 },
  { type: "emote", id: "p2", kind: "skull", nonce: 2 },
]);
```

Keep the rate-limit test passing explicit kinds:

```ts
expect(room.emote(joined.id, "fire", 0)).toEqual({ ok: true });
```

Add to `server/src/presence/socket.test.ts`:

```ts
it("preserves the selected emote kind through the websocket", async () => {
  const ctx = await setup();
  const first = await authenticate(ctx, "alice_1");
  const second = await authenticate(ctx, "bob_2");
  const outbound = nextJson(second.socket);
  first.socket.send(JSON.stringify({ type: "emote", kind: "fire" }));
  await expect(outbound).resolves.toMatchObject({ type: "emote", id: first.id, kind: "fire", nonce: expect.any(Number) });
});
```

- [ ] **Step 5: Run room and socket tests to verify RED**

Run: `cd server && npx vitest run src/presence/room.test.ts src/presence/socket.test.ts`

Expected: FAIL because `PresenceRoom.emote` does not accept or preserve a kind.

- [ ] **Step 6: Implement kind-preserving room broadcast and socket forwarding**

In `server/src/presence/room.ts`:

```ts
emote(id: string, kind: PresenceEmoteKind, now: number): RateLimitResult;

emote(id, kind, now) {
  const member = members.get(id);
  if (!member || !withinRateLimit(member.emoteTimes, now, MAX_EMOTES_PER_WINDOW)) {
    return { ok: false, code: "rate_limited" };
  }
  const message: ServerEmote = { type: "emote", id: member.id, kind, nonce: ++emoteNonce };
  for (const recipient of [...members.values()]) recipient.sink(message);
  return { ok: true };
}
```

In `server/src/presence/socket.ts`, replace the emote branch with:

```ts
const result = message.type === "pose"
  ? deps.room.pose(connection.memberId, message, now())
  : deps.room.emote(connection.memberId, message.kind, now());
```

- [ ] **Step 7: Verify Task 2 and commit**

Run:

```bash
cd server
npx vitest run src/presence/protocol.test.ts src/presence/room.test.ts src/presence/socket.test.ts
npm run build
```

Expected: focused tests PASS and TypeScript build exits 0.

Commit:

```bash
git add server/src/presence/protocol.ts server/src/presence/protocol.test.ts server/src/presence/room.ts server/src/presence/room.test.ts server/src/presence/socket.ts server/src/presence/socket.test.ts
git commit -m "feat(server): broadcast typed paddock emotes"
```

---

### Task 3: Typed Client Emote Transport

**Files:**
- Modify: `redline3d/src/core/presence.ts`
- Modify: `redline3d/src/core/presence.test.ts`

**Interfaces:**
- Produces: `type PresenceEmoteKind = "laugh" | "fire" | "skull"`.
- Changes: `PresenceClient.emote(kind: PresenceEmoteKind): void`.
- Changes: `PresenceEmote.kind: PresenceEmoteKind`.

- [ ] **Step 1: Write failing encode/decode tests**

First import `type PresenceClientOptions` and add this complete local factory to `redline3d/src/core/presence.test.ts`:

```ts
function clientOptions(overrides: Partial<PresenceClientOptions> = {}): PresenceClientOptions {
  return {
    baseUrl: "https://api.example.com",
    auth: fakeAuth("token"),
    WebSocket: FakeWebSocket as never,
    name: () => "alice_1",
    carId: () => "Orion",
    ...overrides,
  };
}
```

Then replace the single-spark expectations with:

```ts
it("sends each selected emote kind", async () => {
  const client = createPresenceClient(clientOptions());
  client.connect();
  await flush();
  const ws = FakeWebSocket.only();
  ws.open();
  client.emote("laugh");
  client.emote("fire");
  client.emote("skull");
  expect(ws.sent.slice(1).map((frame) => JSON.parse(frame))).toEqual([
    { type: "emote", kind: "laugh" },
    { type: "emote", kind: "fire" },
    { type: "emote", kind: "skull" },
  ]);
});

it.each(["laugh", "fire", "skull"] as const)("delivers a complete %s event", async (kind) => {
  const emotes: unknown[] = [];
  const client = createPresenceClient(clientOptions({ onEmote: (event) => emotes.push(event) }));
  client.connect(); await flush();
  const ws = FakeWebSocket.only(); ws.open();
  ws.message({ type: "welcome", id: "self", serverTime: 1 });
  ws.message({ type: "emote", id: "p1", kind, nonce: 1 });
  expect(emotes).toEqual([{ id: "p1", kind, nonce: 1 }]);
});
```

Add this malformed-kind assertion after welcome:

```ts
ws.message({ type: "emote", id: "p1", kind: "spark", nonce: 1 });
ws.message({ type: "emote", id: "p1", kind: "wave", nonce: 2 });
expect(emotes).toEqual([]);
```

- [ ] **Step 2: Run client presence tests to verify RED**

Run: `cd redline3d && npx vitest run src/core/presence.test.ts`

Expected: compile or assertion FAIL because `emote()` accepts no kind and parsing only accepts `spark`.

- [ ] **Step 3: Implement the client union and strict parser**

In `redline3d/src/core/presence.ts`:

```ts
export const PRESENCE_EMOTE_KINDS = ["laugh", "fire", "skull"] as const;
export type PresenceEmoteKind = (typeof PRESENCE_EMOTE_KINDS)[number];

export interface PresenceEmote {
  id: string;
  kind: PresenceEmoteKind;
  nonce: number;
}

function isEmoteKind(value: unknown): value is PresenceEmoteKind {
  return value === "laugh" || value === "fire" || value === "skull";
}
```

Require `isEmoteKind(value.kind)` in `parseServerMessage`, change the interface to `emote(kind: PresenceEmoteKind): void`, and send:

```ts
next.send(JSON.stringify({ type: "emote", kind }));
```

Keep the existing send-error containment and reconnect behavior unchanged.

- [ ] **Step 4: Verify Task 3 and commit**

Run: `cd redline3d && npx vitest run src/core/presence.test.ts`

Expected: all client presence tests PASS.

Commit:

```bash
git add redline3d/src/core/presence.ts redline3d/src/core/presence.test.ts
git commit -m "feat(client): transport typed paddock emotes"
```

---

### Task 4: Centered Live Status and Three-Button Rail

**Files:**
- Modify: `redline3d/src/ui/presence.ts`
- Modify: `redline3d/src/ui/presence.test.ts`
- Modify: `redline3d/src/main.ts:885-910`
- Modify: `redline3d/index.html:105-133`

**Interfaces:**
- Consumes: `PresenceEmoteKind` from `core/presence.ts`.
- Changes: `createPresenceHud(parent, onEmote: (kind: PresenceEmoteKind) => void): PresenceHud`.
- Changes: `PresenceHud.pulse(kind: PresenceEmoteKind): void`.

- [ ] **Step 1: Write failing HUD structure and dispatch tests**

Update `redline3d/src/ui/presence.test.ts` with explicit status and rail lookup:

```ts
test("centers LIVE 3 independently from the right-side emote rail", () => {
  installFakeDocument();
  const parent = new FakeElement();
  const hud = createPresenceHud(parent as never, vi.fn());
  hud.setVisible(true);
  hud.setState("live", 3);
  const status = parent.querySelector("[data-presence-status]")!;
  const rail = parent.querySelector("[data-presence-emotes]")!;
  expect(status.textContent).toBe("LIVE 3");
  expect(status.style.cssText).toContain("left:50%");
  expect(status.style.cssText).toContain("translateX(-50%)");
  expect(rail.style.cssText).toContain("right:max(12px,env(safe-area-inset-right))");
});

test("dispatches laugh, fire, and skull from three ordered buttons", () => {
  installFakeDocument();
  const parent = new FakeElement();
  const sent: string[] = [];
  createPresenceHud(parent as never, (kind) => sent.push(kind));
  const rail = parent.querySelector("[data-presence-emotes]")!;
  const buttons = rail.children.filter((child) => child.tag === "button");
  expect(buttons.map(({ textContent }) => textContent)).toEqual(["😂", "🔥", "💀"]);
  buttons.forEach((button) => button.fire("click"));
  expect(sent).toEqual(["laugh", "fire", "skull"]);
  expect(buttons.map((button) => button.attrs["aria-label"])).toEqual([
    "Send laugh emote", "Send fire emote", "Send skull emote",
  ]);
});
```

Update the pointer-event test to assert exactly three interactive descendants.

- [ ] **Step 2: Run HUD tests to verify RED**

Run: `cd redline3d && npx vitest run src/ui/presence.test.ts`

Expected: FAIL because the current HUD has one combined root and one spark button.

- [ ] **Step 3: Implement the split status and emote rail**

In `redline3d/src/ui/presence.ts`, append two direct children to `parent`:

```ts
const status = document.createElement("div");
status.dataset.presenceStatus = "1";
status.style.cssText = [
  "position:absolute", "top:max(10px,env(safe-area-inset-top))", "left:50%",
  "transform:translateX(-50%)", "z-index:7", "display:none",
  "pointer-events:none", "padding:7px 10px",
  "border:1px solid rgba(46,230,166,.42)", "border-radius:9px",
  "background:rgba(8,7,19,.82)", "box-shadow:0 0 14px rgba(46,230,166,.16)",
  "color:#2ee6a6", "font:800 10px/1 'Chakra Petch',ui-monospace,monospace",
  "letter-spacing:.1em", "text-shadow:0 0 8px currentColor",
].join(";");

const rail = document.createElement("div");
rail.id = "presence-emotes";
rail.dataset.presenceEmotes = "1";
rail.style.cssText = [
  "position:absolute", "top:calc(max(10px,env(safe-area-inset-top)) + 50px)",
  "right:max(12px,env(safe-area-inset-right))", "z-index:7", "display:none",
  "flex-direction:column", "gap:6px", "pointer-events:none",
].join(";");

const defs = [
  { kind: "laugh", glyph: "😂", label: "Send laugh emote", color: "#ffd166" },
  { kind: "fire", glyph: "🔥", label: "Send fire emote", color: "#ff7a3d" },
  { kind: "skull", glyph: "💀", label: "Send skull emote", color: "#d6c7ff" },
] as const;
```

Create the buttons and independent pulse timers with:

```ts
const buttons = new Map<PresenceEmoteKind, HTMLButtonElement>();
const pulseTimers = new Map<PresenceEmoteKind, ReturnType<typeof setTimeout>>();

const pulse = (kind: PresenceEmoteKind) => {
  const button = buttons.get(kind);
  if (!button) return;
  const previous = pulseTimers.get(kind);
  if (previous) clearTimeout(previous);
  button.style.transform = "scale(1.18)";
  button.style.boxShadow = `0 0 22px ${button.dataset.glow}`;
  pulseTimers.set(kind, setTimeout(() => {
    button.style.transform = "scale(1)";
    button.style.boxShadow = `0 0 14px ${button.dataset.glow}`;
    pulseTimers.delete(kind);
  }, 180));
};

for (const def of defs) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.liveEmote = def.kind;
  button.dataset.glow = def.color;
  button.setAttribute("aria-label", def.label);
  button.textContent = def.glyph;
  button.style.cssText = [
    "width:32px", "height:32px", "padding:0", `border:1px solid ${def.color}`,
    "border-radius:9px", "background:rgba(8,7,19,.82)", `color:${def.color}`,
    "cursor:pointer", "pointer-events:auto", "font:800 15px/1 sans-serif",
    "transform:scale(1)", "transition:transform .14s ease,box-shadow .14s ease",
  ].join(";");
  buttons.set(def.kind, button);
  onTap(button, () => { onEmote(def.kind); pulse(def.kind); });
  rail.appendChild(button);
}

parent.appendChild(status);
parent.appendChild(rail);
```

Return `setVisible(visible)` that sets `status.style.display` to `"block"` or `"none"` and `rail.style.display` to `"flex"` or `"none"`. Return the typed `pulse` function unchanged.

- [ ] **Step 4: Wire typed dispatch and landscape menu offset**

In `redline3d/src/main.ts`:

```ts
const presenceHud = createPresenceHud(hudRoot, (kind) => presence?.emote(kind));
```

In the phone-landscape media block in `redline3d/index.html` add:

```css
#presence-emotes{top:calc(max(8px,env(safe-area-inset-top)) + 108px)!important}
```

This tracks the landscape hamburger override at `safe top + 58px`, followed by its 42px height and an 8px gap.

- [ ] **Step 5: Verify Task 4 and commit**

Run:

```bash
cd redline3d
npx vitest run src/ui/presence.test.ts src/core/presence.test.ts
npm run build
```

Expected: HUD and transport tests PASS; build exits 0.

Commit:

```bash
git add redline3d/src/ui/presence.ts redline3d/src/ui/presence.test.ts redline3d/src/main.ts redline3d/index.html
git commit -m "feat(ui): center live status and add emote rail"
```

---

### Task 5: Reusable Remote Emoji Visuals

**Files:**
- Modify: `redline3d/src/render/remote-cars.ts`
- Modify: `redline3d/src/render/remote-cars.test.ts`
- Modify: `redline3d/src/render/lobby.ts`

**Interfaces:**
- Consumes: `PresenceEmoteKind` and `PresenceEmote` from `core/presence.ts`.
- Produces: `RemoteEmoteVisual.pulse(kind: PresenceEmoteKind): void`.
- Keeps: `Lobby.emoteRemote(event: PresenceEmote): void`.

- [ ] **Step 1: Write failing typed visual tests**

Change the fake visual in `redline3d/src/render/remote-cars.test.ts` to expose `pulse(kind)` and add:

```ts
it("selects the typed visual once per fresh nonce", () => {
  const { deps, emotes } = fakeDeps();
  const remotes = createRemoteCars(resolveCar, deps);
  remotes.setTargets([player()]);
  remotes.emote({ id: "p1", kind: "laugh", nonce: 1 });
  remotes.emote({ id: "p1", kind: "laugh", nonce: 1 });
  remotes.emote({ id: "p1", kind: "fire", nonce: 2 });
  remotes.emote({ id: "p1", kind: "skull", nonce: 3 });
  expect(emotes[0].pulse.mock.calls).toEqual([["laugh"], ["fire"], ["skull"]]);
});
```

Keep the existing update and disposal assertions, renamed from spark to emote visual.

- [ ] **Step 2: Run remote-car tests to verify RED**

Run: `cd redline3d && npx vitest run src/render/remote-cars.test.ts`

Expected: FAIL because `pulse()` currently receives no kind and uses one glow texture.

- [ ] **Step 3: Implement shared glyph textures and per-car animation**

In `redline3d/src/render/remote-cars.ts`:

```ts
export interface RemoteEmoteVisual extends RemoteObjectVisual {
  pulse(kind: PresenceEmoteKind): void;
  update(dt: number): void;
}

export interface RemoteCarsDeps {
  makeCar(): RemoteCarVisual;
  makeNameplate(name: string): RemoteObjectVisual;
  makeEmote?(): RemoteEmoteVisual;
}

const EMOTE_GLYPHS: Record<PresenceEmoteKind, { glyph: string; color: string }> = {
  laugh: { glyph: "😂", color: "#ffd166" },
  fire: { glyph: "🔥", color: "#ff6a3d" },
  skull: { glyph: "💀", color: "#d6c7ff" },
};
```

Create three 128px `CanvasTexture` glyphs once per `createRemoteCars` default instance:

```ts
function makeGlyphTexture(glyph: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, 128, 128);
  context.font = "88px 'Apple Color Emoji','Segoe UI Emoji',sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, 64, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeDefaultEmoteResources() {
  const textures: Record<PresenceEmoteKind, THREE.CanvasTexture> = {
    laugh: makeGlyphTexture("😂"),
    fire: makeGlyphTexture("🔥"),
    skull: makeGlyphTexture("💀"),
  };
  return {
    make(): RemoteEmoteVisual {
      const material = new THREE.SpriteMaterial({
        map: textures.laugh,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.y = 6.8;
      sprite.visible = false;
      let age = Infinity;
      return {
        object: sprite,
        pulse(kind) {
          material.map = textures[kind];
          material.color.set(EMOTE_GLYPHS[kind].color);
          material.needsUpdate = true;
          age = 0;
          sprite.visible = true;
          sprite.position.y = 6.8;
          sprite.scale.setScalar(3);
          material.opacity = 1;
        },
        update(dt) {
          if (!sprite.visible) return;
          age += dt;
          const phase = Math.min(1, age / 0.7);
          sprite.position.y = 6.8 + phase * 2.4;
          sprite.scale.setScalar(3 + phase * 3);
          material.opacity = 1 - phase;
          if (phase >= 1) sprite.visible = false;
        },
        dispose() { material.dispose(); },
      };
    },
    dispose() { Object.values(textures).forEach((texture) => texture.dispose()); },
  };
}
```

At `createRemoteCars` construction, select the injected factory or own the default resources:

```ts
const defaultEmotes = deps.makeEmote ? null : makeDefaultEmoteResources();
const makeEmote = deps.makeEmote ?? (() => defaultEmotes!.make());
let disposed = false;
```

Each entry owns the returned sprite material and sprite. Implement final disposal as:

```ts
dispose() {
  if (disposed) return;
  disposed = true;
  clearEntries();
  defaultEmotes?.dispose();
}
```

Injected test factories remain independently disposable.

Change event handling to:

```ts
if (!entry || event.nonce <= entry.lastEmoteNonce) return;
entry.lastEmoteNonce = event.nonce;
entry.emoteVisual.pulse(event.kind);
```

- [ ] **Step 4: Verify Task 5 and commit**

Run:

```bash
cd redline3d
npx vitest run src/render/remote-cars.test.ts
npm run build
```

Expected: remote-car tests PASS and build exits 0.

Commit:

```bash
git add redline3d/src/render/remote-cars.ts redline3d/src/render/remote-cars.test.ts redline3d/src/render/lobby.ts
git commit -m "feat(client): render typed paddock emotes"
```

---

### Task 6: Full Verification and Browser Demo

**Files:**
- No planned source modification. A verification failure returns to the exact task and files that own the regression.

**Interfaces:**
- Verifies the complete design; produces no new public interface.

- [ ] **Step 1: Run all automated suites sequentially**

Run:

```bash
cd redline3d && npm test && npm run build
cd ../server && npm test && npm run build
cd ../packages/engine && npm test
```

Expected:

- Client suite passes with only the existing devnet skips.
- Client production build exits 0.
- Server suite passes with only the existing concurrency skips.
- Server TypeScript build exits 0.
- Engine suite passes.

- [ ] **Step 2: Run final static checks**

Run:

```bash
git diff --check HEAD~5..HEAD
rg -n "wallet|balance|stake|payout" server/src/presence redline3d/src/core/presence.ts
git status --short
```

Expected: no whitespace failures, no financial presence fields, and a clean worktree.

- [ ] **Step 3: Verify cold-load reveal in the browser**

With the server on 8090 and Vite on 3000:

1. Open a fresh cache-busted URL and throttle the local car GLB request beyond nine seconds.
2. Confirm the splash remains visible at nine seconds.
3. Allow the GLB to finish before 20 seconds and confirm the intended model is visible on first reveal.
4. Repeat with a failed request and confirm the neutral fallback reveals without blocking play.

Expected: the pink-lit placeholder never appears during a successful normal cold load.

- [ ] **Step 4: Verify responsive HUD and two-client emotes**

1. In portrait, confirm `LIVE N` is centered and the rail is below the hamburger.
2. In phone landscape, confirm the rail follows the hamburger's `safe top + 58px` override without overlap.
3. Open two named clients and reach `LIVE 2`.
4. Send `😂`, `🔥`, and `💀` in both directions.
5. Confirm each remote car displays the matching glyph once per event.
6. Stop the presence server and confirm `LIVE OFFLINE` while local driving remains usable.

- [ ] **Step 5: Record clean completion or return to the owning task**

If no source fix is required, do not create an empty commit. If a scoped regression is found, return to Task 1 for reveal or car loading, Task 2 for server protocol, Task 3 for client transport, Task 4 for HUD layout, or Task 5 for remote visuals. Follow that task's exact RED, GREEN, build, and commit steps before repeating Task 6.
