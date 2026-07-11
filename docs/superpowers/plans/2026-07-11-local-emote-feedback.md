# Local Emote Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all three lobby emote buttons 42px square and render every server-accepted emote above its sender's car, including the local player's car.

**Architecture:** Move the existing Three.js emoji texture and sprite animation out of `remote-cars.ts` into a reusable resource factory. Remote cars keep sharing one factory-owned texture set, while `main.ts` creates one local visual and routes echoed presence events by the current local presence ID.

**Tech Stack:** TypeScript 5.5, Three.js 0.169, Vitest 2.1, Vite 5.4

## Global Constraints

- Each emote button is exactly 42px by 42px.
- Button order remains `😂`, `🔥`, `💀`.
- The existing button pulse remains immediate local tap feedback.
- The local 3D emoji appears only after the presence server accepts and echoes the event.
- The existing server protocol and two-emotes-per-second rate limit remain unchanged.
- Local and remote rendering exceptions must not interrupt driving.
- The emoji animation remains bounded to 0.7 seconds.
- Do not add dependencies, protocol messages, cooldown UI, chat, history, unlocks, or gameplay effects.

---

## File Structure

- Create `redline3d/src/render/emote-visual.ts`: own glyph/color definitions, shared texture creation, sprite animation, and resource disposal.
- Create `redline3d/src/render/emote-visual.test.ts`: verify texture selection, pulse reset, 0.7-second animation, and disposal.
- Modify `redline3d/src/render/remote-cars.ts`: consume the shared emote visual factory without changing the public remote-car behavior.
- Create `redline3d/src/core/presence-emote-route.ts`: route accepted events to local or remote visuals and contain renderer errors.
- Create `redline3d/src/core/presence-emote-route.test.ts`: verify self/remote routing and failure containment.
- Modify `redline3d/src/main.ts`: attach one emote visual to the local car, remember the local presence ID, route echoed events, and advance the local animation.
- Modify `redline3d/src/ui/presence.ts`: make the three emote buttons 42px square.
- Modify `redline3d/src/ui/presence.test.ts`: lock button size, order, and accessibility in a regression test.

### Task 1: Reusable Three.js emote visual

**Files:**
- Create: `redline3d/src/render/emote-visual.ts`
- Create: `redline3d/src/render/emote-visual.test.ts`
- Modify: `redline3d/src/render/remote-cars.ts:1-145`
- Test: `redline3d/src/render/remote-cars.test.ts`

**Interfaces:**
- Consumes: `PresenceEmoteKind` from `redline3d/src/core/presence.ts` and Three.js `Object3D`, `Texture`, `Sprite`, and `SpriteMaterial`.
- Produces: `EmoteVisual`, `EmoteVisualResources`, `EmoteTextureFactory`, `EMOTE_GLYPHS`, and `createEmoteVisualResources(makeTexture?)`.

- [ ] **Step 1: Write the failing visual tests**

Create `redline3d/src/render/emote-visual.test.ts` with tests that inject a texture factory so no browser canvas is required:

```ts
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { createEmoteVisualResources, EMOTE_GLYPHS } from "./emote-visual";

describe("createEmoteVisualResources", () => {
  it("creates the ordered glyph textures and selects the requested kind", () => {
    const glyphs: string[] = [];
    const textures: THREE.Texture[] = [];
    const resources = createEmoteVisualResources((glyph) => {
      glyphs.push(glyph);
      const texture = new THREE.Texture();
      textures.push(texture);
      return texture;
    });
    const visual = resources.make();
    const sprite = visual.object as THREE.Sprite;
    const material = sprite.material as THREE.SpriteMaterial;

    expect(glyphs).toEqual(["😂", "🔥", "💀"]);
    visual.pulse("fire");
    expect(material.map).toBe(textures[1]);
    expect(material.color.getHexString()).toBe(EMOTE_GLYPHS.fire.color.slice(1));
    expect(sprite.visible).toBe(true);
    expect(sprite.position.y).toBe(6.8);
    expect(sprite.scale.x).toBe(3);
  });

  it("restarts a pulse and hides it after the bounded animation", () => {
    const resources = createEmoteVisualResources(() => new THREE.Texture());
    const visual = resources.make();
    const sprite = visual.object as THREE.Sprite;
    const material = sprite.material as THREE.SpriteMaterial;

    visual.pulse("laugh");
    visual.update(0.35);
    expect(sprite.position.y).toBeCloseTo(8);
    expect(material.opacity).toBeCloseTo(0.5);
    visual.pulse("skull");
    expect(sprite.position.y).toBe(6.8);
    expect(material.opacity).toBe(1);
    visual.update(0.7);
    expect(sprite.visible).toBe(false);
  });

  it("disposes instance material and every shared texture", () => {
    const textures = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
    const disposals = textures.map((texture) => vi.spyOn(texture, "dispose"));
    let index = 0;
    const resources = createEmoteVisualResources(() => textures[index++]);
    const visual = resources.make();
    const material = (visual.object as THREE.Sprite).material as THREE.SpriteMaterial;
    const materialDispose = vi.spyOn(material, "dispose");

    visual.dispose();
    resources.dispose();

    expect(materialDispose).toHaveBeenCalledOnce();
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `cd redline3d && npm test -- src/render/emote-visual.test.ts`

Expected: FAIL because `./emote-visual` does not exist.

- [ ] **Step 3: Implement the shared visual factory**

Create `redline3d/src/render/emote-visual.ts`:

```ts
import * as THREE from "three";
import type { PresenceEmoteKind } from "../core/presence";

export interface EmoteVisual {
  object: THREE.Object3D;
  pulse(kind: PresenceEmoteKind): void;
  update(dt: number): void;
  dispose(): void;
}

export interface EmoteVisualResources {
  make(): EmoteVisual;
  dispose(): void;
}

export type EmoteTextureFactory = (glyph: string) => THREE.Texture;

export const EMOTE_GLYPHS: Record<PresenceEmoteKind, { glyph: string; color: string }> = {
  laugh: { glyph: "😂", color: "#ffd166" },
  fire: { glyph: "🔥", color: "#ff6a3d" },
  skull: { glyph: "💀", color: "#d6c7ff" },
};

const KINDS: PresenceEmoteKind[] = ["laugh", "fire", "skull"];
const START_Y = 6.8;
const DURATION_SECONDS = 0.7;

function makeGlyphTexture(glyph: string): THREE.Texture {
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

export function createEmoteVisualResources(
  makeTexture: EmoteTextureFactory = makeGlyphTexture,
): EmoteVisualResources {
  const textures = Object.fromEntries(
    KINDS.map((kind) => [kind, makeTexture(EMOTE_GLYPHS[kind].glyph)]),
  ) as Record<PresenceEmoteKind, THREE.Texture>;

  return {
    make() {
      const material = new THREE.SpriteMaterial({
        map: textures.laugh,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.y = START_Y;
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
          sprite.position.y = START_Y;
          sprite.scale.setScalar(3);
          material.opacity = 1;
        },
        update(dt) {
          if (!sprite.visible) return;
          age += dt;
          const phase = Math.min(1, age / DURATION_SECONDS);
          sprite.position.y = START_Y + phase * 2.4;
          sprite.scale.setScalar(3 + phase * 3);
          material.opacity = 1 - phase;
          if (phase >= 1) sprite.visible = false;
        },
        dispose() {
          material.dispose();
        },
      } satisfies EmoteVisual;
    },
    dispose() {
      Object.values(textures).forEach((texture) => texture.dispose());
    },
  };
}
```

- [ ] **Step 4: Make remote cars consume the shared module**

In `redline3d/src/render/remote-cars.ts`, import the shared factory and type:

```ts
import { createEmoteVisualResources, type EmoteVisual } from "./emote-visual";
```

Change `RemoteCarsDeps.makeEmote` and `RemoteEntry.emoteVisual` to `EmoteVisual`, delete `RemoteEmoteVisual`, `EMOTE_GLYPHS`, `makeGlyphTexture`, and `makeDefaultEmoteResources`, then initialize the default resource owner with:

```ts
const defaultEmotes = deps.makeEmote ? null : createEmoteVisualResources();
```

Keep the existing `make`, per-entry `update`, per-entry `dispose`, and shared `defaultEmotes?.dispose()` calls unchanged.

- [ ] **Step 5: Run focused visual and remote-car tests**

Run: `cd redline3d && npm test -- src/render/emote-visual.test.ts src/render/remote-cars.test.ts`

Expected: both test files PASS.

- [ ] **Step 6: Commit the reusable renderer**

```bash
git add redline3d/src/render/emote-visual.ts redline3d/src/render/emote-visual.test.ts redline3d/src/render/remote-cars.ts
git commit -m "refactor: share lobby emote visuals"
```

### Task 2: Accepted emote routing

**Files:**
- Create: `redline3d/src/core/presence-emote-route.ts`
- Create: `redline3d/src/core/presence-emote-route.test.ts`

**Interfaces:**
- Consumes: `PresenceEmote` and `PresenceEmoteKind` from `redline3d/src/core/presence.ts`.
- Produces: `PresenceEmoteHandlers` and `routePresenceEmote(event, localId, handlers): void`.

- [ ] **Step 1: Write failing routing tests**

Create `redline3d/src/core/presence-emote-route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { routePresenceEmote } from "./presence-emote-route";

describe("routePresenceEmote", () => {
  const event = { id: "self", kind: "laugh", nonce: 4 } as const;

  it("routes an echoed self event to the local visual", () => {
    const local = vi.fn();
    const remote = vi.fn();
    routePresenceEmote(event, "self", { local, remote });
    expect(local).toHaveBeenCalledWith("laugh");
    expect(remote).not.toHaveBeenCalled();
  });

  it("routes another driver's event to the remote renderer", () => {
    const local = vi.fn();
    const remote = vi.fn();
    routePresenceEmote({ ...event, id: "other" }, "self", { local, remote });
    expect(remote).toHaveBeenCalledWith({ id: "other", kind: "laugh", nonce: 4 });
    expect(local).not.toHaveBeenCalled();
  });

  it("contains optional renderer failures", () => {
    expect(() => routePresenceEmote(event, "self", {
      local: () => { throw new Error("visual failed"); },
      remote: vi.fn(),
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the routing test to verify it fails**

Run: `cd redline3d && npm test -- src/core/presence-emote-route.test.ts`

Expected: FAIL because `./presence-emote-route` does not exist.

- [ ] **Step 3: Implement the routing boundary**

Create `redline3d/src/core/presence-emote-route.ts`:

```ts
import type { PresenceEmote, PresenceEmoteKind } from "./presence";

export interface PresenceEmoteHandlers {
  local(kind: PresenceEmoteKind): void;
  remote(event: PresenceEmote): void;
}

export function routePresenceEmote(
  event: PresenceEmote,
  localId: string | null,
  handlers: PresenceEmoteHandlers,
): void {
  try {
    if (localId !== null && event.id === localId) handlers.local(event.kind);
    else handlers.remote(event);
  } catch {
    // Presence visuals are optional. A renderer failure must not interrupt local driving.
  }
}
```

- [ ] **Step 4: Run the routing tests**

Run: `cd redline3d && npm test -- src/core/presence-emote-route.test.ts`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit accepted-event routing**

```bash
git add redline3d/src/core/presence-emote-route.ts redline3d/src/core/presence-emote-route.test.ts
git commit -m "feat: route accepted lobby emotes"
```

### Task 3: Local car feedback and HUD parity

**Files:**
- Modify: `redline3d/src/main.ts:1-180,894-914,1430-1438`
- Modify: `redline3d/src/ui/presence.ts:86-103`
- Modify: `redline3d/src/ui/presence.test.ts:94-112`
- Test: `redline3d/src/core/presence-emote-route.test.ts`
- Test: `redline3d/src/ui/presence.test.ts`

**Interfaces:**
- Consumes: `createEmoteVisualResources()` from Task 1 and `routePresenceEmote()` from Task 2.
- Produces: a local car child visual that pulses only from echoed self events and three 42px HUD buttons.

- [ ] **Step 1: Add the failing HUD size assertion**

Extend the ordered-button test in `redline3d/src/ui/presence.test.ts` with:

```ts
expect(buttons.map(({ style }) => [style.cssText.includes("width:42px"), style.cssText.includes("height:42px")]))
  .toEqual([[true, true], [true, true], [true, true]]);
```

This stays beside the existing glyph-order and `aria-label` assertions so one test locks the full control contract.

- [ ] **Step 2: Run the HUD test to verify it fails**

Run: `cd redline3d && npm test -- src/ui/presence.test.ts`

Expected: FAIL because each button still contains `width:32px;height:32px`.

- [ ] **Step 3: Make the emote buttons match the hamburger**

In `redline3d/src/ui/presence.ts`, change only these button declarations:

```ts
"width:42px",
"height:42px",
```

Increase the emoji font to preserve the visual proportion:

```ts
"font:800 20px/1 sans-serif",
```

Keep the existing rail position, order, gap, labels, colors, and immediate pulse behavior unchanged.

- [ ] **Step 4: Attach and animate the local visual**

In `redline3d/src/main.ts`, import:

```ts
import { routePresenceEmote } from "./core/presence-emote-route";
import { createEmoteVisualResources } from "./render/emote-visual";
```

Immediately after creating the local car, create one local visual and attach it to the car group:

```ts
const localEmoteResources = createEmoteVisualResources();
const localEmoteVisual = localEmoteResources.make();
car.group.add(localEmoteVisual.object);
```

In the lobby frame branch, immediately after `car.update(dt, drive.speed)`, advance it with:

```ts
localEmoteVisual.update(dt);
```

- [ ] **Step 5: Remember local identity and route server echoes**

Near the presence client setup in `redline3d/src/main.ts`, add:

```ts
let localPresenceId: string | null = null;
```

At the beginning of `onSnapshot`, store the server-provided identity:

```ts
localPresenceId = localId;
```

Replace the remote-only emote callback with:

```ts
onEmote: (event) => routePresenceEmote(event, localPresenceId, {
  local: (kind) => localEmoteVisual.pulse(kind),
  remote: (remoteEvent) => lobby.emoteRemote(remoteEvent),
}),
```

Do not pulse the local 3D visual in the HUD tap callback. The existing `presenceHud` button pulse remains immediate, while the 3D visual waits for this accepted server echo.

- [ ] **Step 6: Run focused UI, routing, renderer, and presence tests**

Run: `cd redline3d && npm test -- src/ui/presence.test.ts src/core/presence-emote-route.test.ts src/render/emote-visual.test.ts src/render/remote-cars.test.ts src/core/presence.test.ts`

Expected: all selected test files PASS.

- [ ] **Step 7: Commit the local feedback feature**

```bash
git add redline3d/src/main.ts redline3d/src/ui/presence.ts redline3d/src/ui/presence.test.ts
git commit -m "feat: show accepted emotes above local car"
```

### Task 4: Full verification and running lobby

**Files:**
- Verify: `redline3d/src/**/*.test.ts`
- Verify: `redline3d/dist/`
- Verify: running client at `http://127.0.0.1:3000/`
- Verify: running API at `http://127.0.0.1:8090/healthz`

**Interfaces:**
- Consumes: the completed client implementation from Tasks 1 through 3.
- Produces: verified production build and a durable local lobby test session.

- [ ] **Step 1: Run the full client test suite**

Run: `cd redline3d && npm test`

Expected: all non-skipped tests PASS with zero failures.

- [ ] **Step 2: Run the production build**

Run: `cd redline3d && npm run build`

Expected: TypeScript exits cleanly and Vite writes the production bundle with zero errors.

- [ ] **Step 3: Restart durable development services**

Stop stale `perps-vite` and `perps-server` screen sessions if present, then start the API on `127.0.0.1:8090` using the repository's existing soft-coin development command and start Vite on `127.0.0.1:3000` with `VITE_API_BASE=http://127.0.0.1:8090`.

Expected: both detached screen sessions remain alive after their launch shell exits.

- [ ] **Step 4: Verify service health**

Run:

```bash
curl --fail --silent --show-error http://127.0.0.1:8090/healthz
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3000/
```

Expected: API returns a healthy response and client request exits 0.

- [ ] **Step 5: Verify the lobby in the browser**

Open `http://127.0.0.1:3000/`, enter the lobby, and confirm:

1. The centered `LIVE N` badge remains independent from the right-side controls.
2. The 😂, 🔥, and 💀 buttons visually match the 42px hamburger.
3. Tapping an emote pulses the HUD button immediately.
4. Once the server echoes the accepted event, the same emoji animates above the local car.
5. A second browser lobby renders that emoji above the sender's remote car.

- [ ] **Step 6: Confirm the worktree is clean**

Run: `git status --short --branch`

Expected: `main` has no unstaged or staged changes and is ahead of `origin/main` by the new local commits.

