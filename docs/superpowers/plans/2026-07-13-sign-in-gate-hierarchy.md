# Sign-In Gate Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account sign-in the primary identity-gate action, keep guest practice mode visibly secondary, and ship the same verified client build to Railway, the website APK route, and the connected Seeker.

**Architecture:** Keep the existing `createIdentityGate` API and callbacks unchanged. Change only its rendered hierarchy, scoped presentation, and supporting copy, then prove the behavior and hierarchy in a jsdom test before producing the web and Android release artifacts.

**Tech Stack:** TypeScript, DOM APIs, Vitest with jsdom, Vite, Capacitor Android, Railway, Caddy

## Global Constraints

- `SIGN IN` is the first, large glowing green primary action.
- Sign-in benefit copy is exactly `save progress · collect cars · play for real SOL`.
- `RIDE AS GUEST` remains visible as a smaller dark outlined secondary action.
- Guest copy is exactly `practice mode · no wallet required`.
- Driver name remains optional for sign-in and required for guest mode.
- Privy authentication, identity persistence, validation, dismiss, busy, error, focus, and keyboard behavior do not change.
- Do not hide or remove guest mode.
- Do not use em dashes in new user-facing copy.
- The APK installed on Seeker and the APK published at `/downloads/perps-rider.apk` must have the same SHA-256 checksum.

---

### Task 1: Reverse the Identity-Gate Visual Hierarchy

**Files:**
- Modify: `redline3d/src/ui/identity.ts`
- Test: `redline3d/src/ui/identity.test.ts`

**Interfaces:**
- Consumes: `createIdentityGate(parent, { onGuest, onSignIn, prefill?, onDismiss? }): IdentityGate`
- Produces: the same `createIdentityGate` interface with unchanged callbacks and validation behavior

- [ ] **Step 1: Write the failing hierarchy and behavior tests**

Add the jsdom environment pragma, import `afterEach`, `vi`, and `createIdentityGate`, then append these tests:

```ts
/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createIdentityGate, validateName } from "./identity";

afterEach(() => {
  document.body.replaceChildren();
});

test("presents sign-in as the primary action before guest practice", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  const signIn = gate.el.querySelector<HTMLButtonElement>("#idsignin")!;
  const guest = gate.el.querySelector<HTMLButtonElement>("#idguest")!;

  expect(signIn.classList).toContain("cta");
  expect(signIn.classList).toContain("identity-primary");
  expect(guest.classList).not.toContain("cta");
  expect(guest.classList).toContain("identity-secondary");
  expect(signIn.compareDocumentPosition(guest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(gate.el.textContent).toContain("save progress · collect cars · play for real SOL");
  expect(gate.el.textContent).toContain("practice mode · no wallet required");
});

test("keeps sign-in name optional and guest name required", async () => {
  const onGuest = vi.fn();
  const onSignIn = vi.fn().mockResolvedValue(false);
  const gate = createIdentityGate(document.body, { onGuest, onSignIn });

  gate.el.querySelector<HTMLButtonElement>("#idsignin")!.click();
  await Promise.resolve();
  expect(onSignIn).toHaveBeenCalledWith(null);

  gate.el.querySelector<HTMLInputElement>("#idname")!.value = "ab";
  gate.el.querySelector<HTMLButtonElement>("#idguest")!.click();
  expect(onGuest).not.toHaveBeenCalled();

  gate.el.querySelector<HTMLInputElement>("#idname")!.value = "neon_rider";
  gate.el.querySelector<HTMLButtonElement>("#idguest")!.click();
  expect(onGuest).toHaveBeenCalledWith("neon_rider");
});
```

- [ ] **Step 2: Run the focused test and verify the new hierarchy test fails for the expected reason**

Run:

```bash
cd redline3d
npm test -- src/ui/identity.test.ts
```

Expected: the existing validation tests pass, while `presents sign-in as the primary action before guest practice` fails because the current guest button owns `.cta` and appears before sign-in.

- [ ] **Step 3: Implement the approved hierarchy and scoped styles**

In `createIdentityGate`, keep the title and field, replace the action portion of `card.innerHTML` with the following ordering and copy, and preserve the optional close button:

```ts
`<style>
  #idsignin.identity-primary:focus-visible,
  #idguest.identity-secondary:focus-visible,
  #idname:focus-visible {
    outline:2px solid var(--cyan);
    outline-offset:3px;
  }
  #idguest.identity-secondary {
    width:100%;
    padding:11px 13px;
    border-radius:11px;
    border:1px solid rgba(39,231,255,.34);
    background:rgba(12,10,26,.74);
    color:#aeb8dc;
    cursor:pointer;
    font:700 12px 'Chakra Petch',ui-monospace,monospace;
    letter-spacing:.1em;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
  }
  #idguest.identity-secondary:active { transform:translateY(1px); }
  #idsignin:disabled,
  #idguest:disabled { cursor:progress;filter:saturate(.55); }
</style>` +
`<div class="num" style="font-size:26px;letter-spacing:.14em;color:var(--cyan);text-shadow:0 0 18px rgba(39,231,255,.5)">PERPS RIDER</div>` +
`<div class="lbl" style="letter-spacing:.08em;color:#aeb8dc">driver name · optional for sign in</div>` +
`<input id="idname" maxlength="16" autocomplete="off" spellcheck="false" placeholder="e.g. liq_dodger"
  style="width:100%;box-sizing:border-box;padding:13px 14px;border-radius:11px;border:1px solid var(--line);background:rgba(10,8,22,.85);color:#eef1ff;font:700 17px 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-align:center;outline:none"/>` +
`<div id="idmsg" class="lbl" style="min-height:13px;color:#ff9db1"></div>` +
`<button id="idsignin" class="cta identity-primary" type="button" style="width:100%"><span></span><span>SIGN IN</span></button>` +
`<div class="lbl" style="color:#2ee6a6;letter-spacing:.1em;line-height:1.45">save progress · collect cars · play for real SOL</div>` +
`<div style="height:1px;background:linear-gradient(90deg,transparent,rgba(132,150,224,.26),transparent);margin:1px 0"></div>` +
`<button id="idguest" class="identity-secondary" type="button">RIDE AS GUEST</button>` +
`<div class="lbl" style="color:#8d9ac4;letter-spacing:.1em">practice mode · no wallet required</div>` +
`<div class="lbl" style="opacity:.75;line-height:1.6">driver name required for guests<br>hold the road to drive · park at <b style="color:#14f195">TRACK</b> to race</div>`;
```

The existing `setBusy`, click handlers, validation, dismiss behavior, and focus timeout remain unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd redline3d
npm test -- src/ui/identity.test.ts
```

Expected: 4 tests pass with 0 failures.

- [ ] **Step 5: Run the full client verification**

Run:

```bash
cd redline3d
npm test
npm run build
```

Expected: all Vitest files pass and the Vite production build exits 0 with both landing and play entries emitted.

- [ ] **Step 6: Commit the tested UI change**

```bash
git add redline3d/src/ui/identity.ts redline3d/src/ui/identity.test.ts
git commit -m "feat: emphasize account sign-in"
```

---

### Task 2: Release the Same Build to Railway, Website, and Seeker

**Files:**
- Build artifact: `redline3d/android/app/build/outputs/apk/debug/app-debug.apk`
- Remote website artifact: `/usr/share/caddy/models/perps-rider.apk`

**Interfaces:**
- Consumes: the committed and verified Task 1 source tree
- Produces: updated Railway web deployment, installed Android package `xyz.redline.game`, and website APK download with matching SHA-256

- [ ] **Step 1: Confirm Railway and Seeker targets**

Run:

```bash
railway status
/opt/homebrew/share/android-commandlinetools/platform-tools/adb devices -l
```

Expected: project `redline3d-live`, environment `production`, service `redline-web`, and connected device `SM02E4072816959`.

- [ ] **Step 2: Build and install the APK on Seeker**

Run:

```bash
cd redline3d
npm run apk:install
```

Expected: web build, Capacitor sync, Gradle `assembleDebug`, and `adb install -r` all exit 0.

- [ ] **Step 3: Record the local artifact identity**

Run:

```bash
shasum -a 256 redline3d/android/app/build/outputs/apk/debug/app-debug.apk
stat -f '%z' redline3d/android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: one SHA-256 and one non-zero byte count to compare against the public artifact.

- [ ] **Step 4: Deploy the web client to Railway**

Run from the repository root:

```bash
railway up --service redline-web --environment production --ci --message "Emphasize account sign-in"
```

Expected: Railway build and deployment complete without error.

- [ ] **Step 5: Publish the APK into the Railway volume**

Serve the APK from its output directory, expose it through a temporary Cloudflare tunnel, download it to a temporary remote filename, verify it, and atomically rename it to `/usr/share/caddy/models/perps-rider.apk`:

```bash
APK_DIR="$PWD/redline3d/android/app/build/outputs/apk/debug"
python3 -m http.server 8078 --bind 127.0.0.1 --directory "$APK_DIR" >/tmp/perps-apk-server.log 2>&1 &
SERVER_PID=$!
cloudflared tunnel --url http://127.0.0.1:8078 --no-autoupdate >/tmp/perps-apk-tunnel.log 2>&1 &
TUNNEL_PID=$!
for attempt in {1..30}; do
  TUNNEL_URL="$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/perps-apk-tunnel.log | head -1)"
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done
test -n "$TUNNEL_URL"
railway ssh wget -q -O /usr/share/caddy/models/perps-rider.apk.uploading "$TUNNEL_URL/app-debug.apk"
railway ssh sh -lc 'sha256sum /usr/share/caddy/models/perps-rider.apk.uploading && wc -c /usr/share/caddy/models/perps-rider.apk.uploading'
railway ssh mv /usr/share/caddy/models/perps-rider.apk.uploading /usr/share/caddy/models/perps-rider.apk
kill "$TUNNEL_PID" "$SERVER_PID"
```

Expected: remote checksum and byte count match Step 3 before the atomic rename, then both temporary local processes stop.

- [ ] **Step 6: Verify the production website, game route, and APK**

Run:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://perpsrider.com/
curl -fsS -o /dev/null -w '%{http_code}\n' https://perpsrider.com/play/
curl -fsS https://perpsrider.com/downloads/perps-rider.apk | shasum -a 256
/opt/homebrew/share/android-commandlinetools/platform-tools/adb shell dumpsys package xyz.redline.game | rg 'versionName|versionCode'
```

Expected: both web routes return `200`, the public APK checksum matches Step 3, and the installed package reports its version.
