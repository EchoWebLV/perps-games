# Highway Building Access Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Highway available on loopback hosts while showing `Highway coming soon` from the Highway building on Railway and every other public host.

**Architecture:** A pure hostname predicate owns the loopback allowlist. The existing `triggerBuilding("highway")` branch consults it before entering Highway, keeping all other building behavior unchanged.

**Tech Stack:** TypeScript, Vitest, Vite

## Global Constraints

- Allow `localhost`, `127.0.0.1`, `::1`, and `[::1]`.
- Block every other hostname without a bypass.
- Gate only the Highway building.
- Preserve all unrelated worktree changes.

---

### Task 1: Gate Highway Building Entry

**Files:**
- Create: `redline3d/src/core/highway-access.ts`
- Create: `redline3d/src/core/highway-access.test.ts`
- Modify: `redline3d/src/main.ts` in the imports and `triggerBuilding`

**Interfaces:**
- Produces: `highwayAvailable(hostname: string): boolean`
- Consumes: `globalThis.location.hostname` and `lobbyHud.toast(message)`

- [ ] **Step 1: Write the failing tests**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { highwayAvailable } from "./highway-access";

describe("highwayAvailable", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])("allows loopback host %s", (hostname) => {
    expect(highwayAvailable(hostname)).toBe(true);
  });

  it.each(["redline-web-production.up.railway.app", "perps.example.com", ""])("blocks public host %s", (hostname) => {
    expect(highwayAvailable(hostname)).toBe(false);
  });

  it("gates only the Highway building branch", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const start = main.indexOf('case "highway"');
    const end = main.indexOf("\n  }", start);
    const branch = main.slice(start, end);
    expect(branch).toContain("highwayAvailable");
    expect(branch).toContain('lobbyHud.toast("Highway coming soon")');
    expect(main).toContain('case "track": exitFrom = "track"; exitLobby();');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test --prefix redline3d -- src/core/highway-access.test.ts`

Expected: FAIL because `./highway-access` does not exist.

- [ ] **Step 3: Implement the predicate**

```ts
export function highwayAvailable(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
```

- [ ] **Step 4: Gate the Highway branch**

Import `highwayAvailable` in `redline3d/src/main.ts`, then replace the Highway case with:

```ts
case "highway":
  if (!highwayAvailable(globalThis.location?.hostname ?? "")) {
    lobbyHud.toast("Highway coming soon");
    break;
  }
  exitFrom = "highway";
  enterHighway();
  break;
```

- [ ] **Step 5: Run focused tests and production build**

Run: `npm test --prefix redline3d -- src/core/highway-access.test.ts src/core/lobby-layout.test.ts && npm run build --prefix redline3d`

Expected: all tests pass and Vite production build exits successfully.

- [ ] **Step 6: Verify both host outcomes in the browser**

On `http://localhost:3000`, activate Highway and confirm Highway opens. Build a local preview served under a non-loopback host header, activate Highway, and confirm the player stays in the lobby with `Highway coming soon`.

- [ ] **Step 7: Commit only the gate files**

```bash
git add redline3d/src/core/highway-access.ts redline3d/src/core/highway-access.test.ts redline3d/src/main.ts
git commit -m "feat: gate Highway to localhost"
```
