# Account-scoped Tutorial Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the tutorial once for each signed-in Privy account while retaining one device-local tutorial for guests.

**Architecture:** Keep tutorial persistence inside `ui/howto.ts`, extending its injectable storage helpers with an optional wallet namespace. Thread `session.address()` through the two signed-in tutorial entry paths in `main.ts`; guest entry remains unscoped. No Railway API, database, access-wall, welcome-gift, or save-vault behavior changes.

**Tech Stack:** TypeScript, browser localStorage, Vitest, Vite, Capacitor Android, Railway CLI

## Global Constraints

- Each signed-in Privy account sees the tutorial automatically once per device.
- Returning to the same account does not auto-show it again.
- Guests continue using the existing `raider.howto.v1` device key.
- Solana wallet addresses remain case-sensitive and are used verbatim.
- Manual tutorial replay, access-wall ordering, welcome crates, and save switching remain unchanged.
- No Railway schema or API change.

---

### Task 1: Namespace tutorial completion flags

**Files:**
- Modify: `redline3d/src/ui/howto.ts:1-10`
- Test: `redline3d/src/ui/howto.test.ts:1-45`

**Interfaces:**
- Consumes: `KvStore` with `get(key)` and `set(key, value)`.
- Produces: `howToSeen(store?: KvStore, namespace?: string): boolean` and `markHowToSeen(store?: KvStore, namespace?: string): void`.

- [ ] **Step 1: Write the failing account-isolation tests**

Replace the existing seen-flag describe block with:

```ts
describe("how-to seen flag", () => {
  test("keeps the guest flag once per device", () => {
    const store = memStore();
    expect(howToSeen(store)).toBe(false);
    markHowToSeen(store);
    expect(howToSeen(store)).toBe(true);
  });

  test("keeps separate completion flags for separate signed-in accounts", () => {
    const store = memStore();
    markHowToSeen(store, "WalletAccountA");

    expect(howToSeen(store, "WalletAccountA")).toBe(true);
    expect(howToSeen(store, "WalletAccountB")).toBe(false);
    expect(howToSeen(store)).toBe(false);
  });

  test("preserves case-sensitive Solana wallet namespaces", () => {
    const store = memStore();
    markHowToSeen(store, "AbCd123");

    expect(howToSeen(store, "AbCd123")).toBe(true);
    expect(howToSeen(store, "abcd123")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the regression fails**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts
```

Expected: the account-isolation test fails because the current functions ignore the namespace and mark the shared guest key.

- [ ] **Step 3: Implement namespaced keys**

Replace the flag definitions in `redline3d/src/ui/howto.ts` with:

```ts
const KEY = "raider.howto.v1";
const seenKey = (namespace?: string): string => namespace ? `${KEY}:${namespace}` : KEY;

/** true once this guest device or signed-in account has seen/skipped the walkthrough. */
export function howToSeen(store: KvStore = browserStore, namespace?: string): boolean {
  return store.get(seenKey(namespace)) === "1";
}

/** mark this guest device or signed-in account as having seen the walkthrough. */
export function markHowToSeen(store: KvStore = browserStore, namespace?: string): void {
  store.set(seenKey(namespace), "1");
}
```

- [ ] **Step 4: Run the focused tutorial tests**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts
```

Expected: all tutorial tests pass.

- [ ] **Step 5: Commit the persistence behavior**

```bash
git add redline3d/src/ui/howto.ts redline3d/src/ui/howto.test.ts
git commit -m "fix: scope tutorial completion by player"
```

### Task 2: Pass the signed-in account namespace through onboarding

**Files:**
- Modify: `redline3d/src/main.ts:38,48,2125-2130,2200-2280`
- Test: `redline3d/src/ui/howto.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers `howToSeen(store, namespace)` and `markHowToSeen(store, namespace)`.
- Produces: `maybeShowHowTo(after: () => void, namespace?: string): void`, with signed-in callers passing `session.address()`.

- [ ] **Step 1: Write the failing main-wiring regression test**

Add `readFile` to the imports and append this test to `redline3d/src/ui/howto.test.ts`:

```ts
import { readFile } from "node:fs/promises";

test("scopes automatic signed-in tutorials to the wallet while leaving guests device-local", async () => {
  const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  const start = main.indexOf("function maybeShowHowTo");
  const end = main.indexOf("\n}\n", start) + 2;
  const helper = main.slice(start, end);

  expect(helper).toContain("namespace?: string");
  expect(helper).toContain("howToSeen(browserStore, namespace)");
  expect(helper).toContain("markHowToSeen(browserStore, namespace)");
  expect(main).toContain("maybeShowHowTo(() => maybeWelcomeGift())");
  expect(main.match(/maybeShowHowTo\([^;]+session\.address\(\)\)/gs)).toHaveLength(2);
});
```

- [ ] **Step 2: Run the wiring test and verify it fails**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts
```

Expected: FAIL because `maybeShowHowTo` has no namespace and signed-in callers do not pass `session.address()`.

- [ ] **Step 3: Thread the namespace through `main.ts`**

Extend the identity import:

```ts
import { accountSignInTransition, browserStore } from "./core/identity";
```

Change the helper to:

```ts
function maybeShowHowTo(after: () => void, namespace?: string) {
  if (howToSeen(browserStore, namespace)) { after(); return; }
  howto.open(() => { markHowToSeen(browserStore, namespace); after(); });
}
```

Keep the guest caller unchanged:

```ts
guestAccessThenEnter(() => { maybeShowHowTo(() => maybeWelcomeGift()); });
```

Change both account callers, the successful in-place sign-in and boot reconnect, to pass the authenticated wallet:

```ts
accountAccessThenEnter(() => {
  maybeShowHowTo(() => { void offerWelcomeAccount(); }, session.address());
});
```

- [ ] **Step 4: Run focused tests and the full client suite**

Run:

```bash
cd redline3d
npx vitest run src/ui/howto.test.ts src/core/identity.test.ts src/core/access-code.test.ts
npm test
npm run build
```

Expected: focused tests, all client tests, TypeScript, and Vite build pass.

- [ ] **Step 5: Commit the onboarding wiring**

```bash
git add redline3d/src/main.ts redline3d/src/ui/howto.test.ts
git commit -m "fix: show tutorial once per signed-in account"
```

### Task 3: Deploy and verify the completed client

**Files:**
- Verify: `redline3d/android/app/build/outputs/apk/debug/app-debug.apk`
- Verify: Railway service `redline-web` in `production`

**Interfaces:**
- Consumes: the committed client from Tasks 1 and 2.
- Produces: a Railway web deployment and an installed Seeker APK containing the same tutorial behavior.

- [ ] **Step 1: Verify repository state and the final commits**

```bash
git diff --check
git status --short --branch
git log -3 --oneline
```

Expected: no tracked modifications; only the pre-existing untracked `artifacts/` directory remains.

- [ ] **Step 2: Deploy the exact committed snapshot to Railway**

```bash
tmpdir=$(mktemp -d)
git archive HEAD redline3d packages/engine | tar -x -C "$tmpdir"
cp .railwayignore "$tmpdir/.railwayignore"
railway up "$tmpdir" --path-as-root --service redline-web --environment production --ci --message "Scope tutorial state by account"
rm -rf "$tmpdir"
```

Expected: Railway accepts the upload and the resulting `redline-web` deployment reaches `SUCCESS`.

- [ ] **Step 3: Build and install the Android APK**

```bash
cd redline3d
npm run apk:install
```

Expected: Gradle reports `BUILD SUCCESSFUL`, ADB reports `Success`, and the APK exists at `android/app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 4: Cold-launch the Seeker app and inspect native logs**

```bash
ADB=/opt/homebrew/share/android-commandlinetools/platform-tools/adb
$ADB logcat -c
$ADB shell am force-stop xyz.redline.game
$ADB shell am start -W -n xyz.redline.game/.MainActivity
sleep 8
$ADB logcat -d -t 4000 | rg -i 'Perps Raider render up|FATAL EXCEPTION|Process: xyz.redline.game'
```

Expected: `Perps Raider render up` appears and no fatal exception for `xyz.redline.game` appears.

- [ ] **Step 5: Verify Railway and the public endpoint**

```bash
railway deployment list --service redline-web --environment production --limit 1 --json
curl -fsSI https://redline-web-production.up.railway.app/
```

Expected: the latest deployment status is `SUCCESS` and the endpoint returns HTTP 200.
