# Seeker on-device checklist — Privy login + play (2026-07-08)

**Who runs this:** you, on the actual Seeker phone. Claude can't touch hardware.
**Why it matters:** this is THE gating risk for the July 10–12 MagicBlock mobile hackathon.
Privy sign-in inside the Android APK WebView has never been proven on the device.
Everything else (driving, crates, garage) already runs in the browser — the unknown is
whether **email one-time-code login works inside the app's WebView.**

Fill in the results table as you go. If a step fails, jump to the **Fallback decision tree**
at the bottom, then keep going where you can.

---

## What the app will do (so you know what "correct" looks like)

- The APK ships the whole game **inside** it. It does not load from your Mac — once installed
  it runs offline-capable from an internal address (`https://localhost`). The only things it
  reaches out to over the network are: **Privy** (login), the **price feed**, the Solana
  **RPC**, and our **account server** (coins/cars sync).
- Login is **Privy only**. There is no MetaMask/Phantom step. You sign in with an **email**
  (or SMS) and Privy silently creates a Solana wallet for you behind the scenes.
- The account server is **optional**. If it's unreachable the game still runs on the phone's
  local save; it just won't cross-sync to desktop until the server is back. (Code: a failed
  server sync is caught and swallowed — `src/main.ts` `syncAccount()`.)
- Money is on **devnet** right now (the wallet panel prints "Solana · devnet"). No real SOL.

---

## Prerequisites (do these on the Mac first)

- [ ] **JDK 21** installed at the Homebrew path (NOT 17). The build script hard-requires it:
      `redline3d/scripts/build-apk.sh` sets `JAVA_HOME=/opt/homebrew/opt/openjdk@21/...`.
- [ ] Android command-line tools present (`ANDROID_HOME`), same script checks for `adb`.
- [ ] The `.env` in `redline3d/` has **`VITE_PRIVY_APP_ID`** set (it does today). This is baked
      into the APK at build time, so **rebuild after any `.env` change.**
- [ ] **Privy dashboard pre-flight (the #1 thing that silently breaks WebView login):**
      In the Privy app dashboard → app settings → **Allowed origins / domains**, make sure
      **`https://localhost`** is on the list. That is the exact origin the APK's WebView
      presents (Capacitor default: `androidScheme = https`, `hostname = localhost`; we set no
      override). If it's missing, Privy refuses to start and you'll hit `privy_unreachable`.
- [ ] **Privy dashboard login methods:** confirm **Email** (and/or SMS) is enabled. If **Google
      / Apple / other social** buttons are enabled, expect them to fail inside the WebView —
      use the email code instead (see fallback). We do **not** pin login methods in code today,
      so whatever the dashboard shows is what appears in the app.
- [ ] Decide server mode: is our account server reachable from the phone's network
      (`VITE_API_BASE`)? Either is fine — just note **"server on"** or **"server off"** so the
      cross-device step (step 9) is interpreted correctly.
- [ ] Phone and Mac on the **same Wi-Fi** (needed for the download-install route below).
- [ ] **(Optional) Perf-diagnostic build.** The frame-rate levers are **build-time env pins**,
      baked in like `VITE_PRIVY_APP_ID`, because the APK's address-bar-less WebView can't take the
      `?fps` / `?perf` URL params you'd use in the browser. Only needed for the on-device fps
      readout or a forced tier in **step 11** (recipes there). A **default** build needs none of
      this — the tier the game auto-picks already prints at boot as `redline3d quality: <tier>`,
      readable over `adb logcat`.

---

## Build & install

**1. Build + serve the APK over LAN (the no-USB route that works on the Seeker).**
On the Mac, from `redline3d/`:

```
npm run apk:serve
```

Wait for `✅ APK built`, then the script prints a URL like `http://<mac-ip>:8077/redline.apk`.

- [ ] Build finished without errors.
- [ ] URL printed.

**2. Install on the Seeker.**
On the phone, open **Chrome** → type that `http://<mac-ip>:8077/redline.apk` URL →
**Download** → tap the file → allow **"install unknown apps"** if asked → **Install**.

- [ ] APK downloaded and installed.
- [ ] "Redline 3D" appears in the app drawer.

> (If you have USB debugging set up instead, `npm run apk:install` sideloads over the cable.
> The LAN route above is the one noted as reliable on the Seeker.)

---

## First run

**3. First boot → identity gate.**
Launch **Redline 3D**. Expect: the game scene loads, then a centered card titled
**PERPS RIDER** with a **driver name** box, a green **RIDE AS GUEST** button, and a
**SIGN IN** button. (Code: `src/main.ts` shows the gate when no saved identity;
`src/ui/identity.ts` draws it.)

- [ ] Identity gate appears on first launch.
- [ ] No blank/white screen, no crash.

**4. RIDE AS GUEST sanity (proves the game itself runs before we touch login).**
Type a name (3–16 chars, letters/numbers/underscore — e.g. `liq_dodger`) → **RIDE AS GUEST**.
Expect: gate closes, you're on the strip, the top money chip reads **practice** (not a SOL
number). Hold the road to drive.

- [ ] Name accepted, gate closed.
- [ ] Money chip shows **practice**.
- [ ] Car drives when you hold the road.

**5. Guest GO → practice round loop.**
Drive to **TRACK** (or use GO) and start a round. As a guest this is a **free practice**
round — no wallet, no chain. Confirm the round opens, the price line moves, and it settles.

- [ ] Practice round opened and ran.
- [ ] It settled/closed without hanging.

---

## The real test — Privy sign-in

> This is the part we cannot verify without you. Go slowly and write down exactly what each
> screen looks like. If it stalls, note **how long** and **what was on screen** before you retry.

**6. Open the sign-in gate.**
If you're in guest mode, open the menu / tap the identity chip to bring the gate back, then
tap **SIGN IN**. (You can leave the name blank — sign-in doesn't need one; it'll auto-name you
`rider_<last4>`.) The button changes to **CONNECTING…**.

- [ ] Button shows **CONNECTING…**.
- [ ] Within a few seconds a **Privy login panel** slides up **inside the app** (it is an
      in-page panel, NOT a new browser window). ✅ good sign.

**What failure looks like here — write down which one you see:**
- ❌ **"Couldn't reach sign-in — check your connection and try again."** → this is
  `privy_unreachable`: Privy didn't start within ~25s. Almost always the **`https://localhost`
  origin isn't allowlisted** in the Privy dashboard, or the app id is wrong. → Fallback A.
- ❌ **Spinner forever / blank panel** (no email box ever appears) → Privy's secure frame
  (`auth.privy.io`) isn't loading in the WebView. → Fallback C.

**7. Email one-time-code path.**
In the Privy panel choose **email**, type your email, tap continue. Expect a screen asking for
a **6-digit code**. Check your email, enter the code.

- [ ] Email box appeared and accepted your address.
- [ ] 6-digit code screen appeared.
- [ ] Code accepted → panel closes, you're back in the game.

**What failure looks like here — write down which one you see:**
- ❌ You tapped a **Google / Apple** button and got a Google page saying
  **"this browser or app may not be secure" / `disallowed_useragent`**, or a blank page →
  that's social OAuth being blocked in the WebView. **Back out and use the email code instead.**
  → Fallback B for the permanent fix.
- ❌ Code never arrives / "invalid code" loops → note it; retry once; then Fallback C.
- ❌ Panel closes but nothing happens for a long time, then a **"Sign-in didn't finish"** message
  → note how long you waited.

**8. Wallet address appears + balance chip flips off "practice".**
After the code succeeds, Privy provisions a Solana wallet automatically. Open the **wallet
panel** (tap the balance chip). Expect a **QR code + a Solana address** (`Copy` button), and the
top chip now shows a **SOL number** (0.000 on a fresh devnet wallet) instead of "practice".

- [ ] Wallet panel shows a real Solana **address** + QR.
- [ ] Top chip shows a **SOL balance** (not "practice").

> (If you want to test a funded GO: send a little **devnet** SOL to that address, reopen the
> panel to see it arrive, then press GO. Optional — the login proof is the address appearing.)

---

## Persistence & cross-device

**9. Kill + relaunch → still signed in, coins intact.**
Fully close the app (swipe it away from recents), relaunch. Expect: **no identity gate** — it
remembers you — and after a moment the money chip shows your balance again (the app silently
restores the Privy session and re-pulls coins/cars). Check your coins/cars count matches.

- [ ] No gate on relaunch (remembered you).
- [ ] Coins / cars / scrap match what you had.

**10. Cross-device check (only meaningful if server = ON).**
On a **desktop browser**, open the web build and **sign in with the same email**. Expect the
**same coins/cars** to appear (the server is the source of truth and wins on conflict). Then do
something on desktop (open a crate / earn coins), sign in again on the phone, confirm it carried.

- [ ] Same email on desktop → same account balances.
- [ ] A change on one device shows up on the other after re-sign-in.
- [ ] (If server = OFF, write "N/A — server off". Local-only is expected then.)

---

## Feel & device health

**11. Frame-rate feel.**
Drive around the lobby and a round. Note if it feels smooth or choppy. The Seeker's GPU
(Mali-G615) in the throttled WebView is the known perf risk — watch for stutter when the
scene is busy (crate reveal, garage showroom, many cruisers).

- [ ] Smooth enough to play / demo? (yes / borderline / no)

> **On-device perf diagnostics (optional — reach for these if it feels choppy).** The `?fps` /
> `?perf` URL levers you'd use in the browser **don't work inside the APK** — the WebView loads a
> fixed `https://localhost/` with no address bar to add them to (same reason as Fallback E). The
> APK-reachable equivalents are **build-time env pins**, baked in like `VITE_PRIVY_APP_ID`. From
> `redline3d/`:
> - `VITE_FPS=1 npm run apk:serve` — bakes in the **fps chip** (top-left, stacked under the scrap
>   chip) so you can read the live frame rate on the phone.
> - `VITE_PERF=low npm run apk:serve` — **forces the low tier** (caps pixelRatio at 1.5) to check
>   whether the low path is smooth enough to demo; `VITE_PERF=high` forces the high tier to see the
>   worst case. On a web build a `?perf` / `?fps` URL param still wins over the pin, so desktop
>   debugging is unchanged.
> - On a **default** build (no pins) you don't need to rebuild to learn the tier: the one the game
>   auto-picked prints at boot as `redline3d quality: <tier> (<gpu>)` — read it over USB with
>   **`adb logcat | grep redline3d`**.

**12. Battery & heat.**
After ~10 minutes of play, note if the phone is **hot** or the **battery** dropped fast. A 3D
WebGL game will warm the device; we just want to know it's demo-safe, not thermal-throttling
into a slideshow.

- [ ] Temperature: fine / warm / hot.
- [ ] Battery drain over 10 min: __%.

---

## Results table (fill this in)

| # | Step | Pass / Fail | Notes (exact screen text, timing, anything odd) |
|---|------|-------------|--------------------------------------------------|
| 1 | Build + serve APK | | |
| 2 | Install on Seeker | | |
| 3 | First boot → identity gate | | |
| 4 | RIDE AS GUEST + drive | | |
| 5 | Guest GO practice round | | |
| 6 | SIGN IN → Privy panel opens in-app | | |
| 7 | Email one-time-code accepted | | |
| 8 | Wallet address + balance appears | | |
| 9 | Kill + relaunch, coins intact | | |
| 10 | Cross-device same email (server on) | | |
| 11 | Frame-rate feel | | |
| 12 | Battery / heat | | |

---

## Fallback decision tree

Work top-down. Each fix says **where** the change goes; ask Claude to make it, then rebuild the APK.

**A. "Couldn't reach sign-in" (`privy_unreachable`) at step 6.**
Most likely the WebView origin isn't allowlisted.
1. In the **Privy dashboard**, add **`https://localhost`** to Allowed origins/domains. (No code
   change, no rebuild — just retry the app.)
2. If still failing, double-check **`VITE_PRIVY_APP_ID`** in `redline3d/.env` is the right app,
   then **rebuild** (`npm run apk:serve`) since the id is baked in at build time.

**B. A Google/Apple button showed `disallowed_useragent` at step 7.**
Email/SMS code works; social OAuth is blocked in embedded WebViews. Two fixes:
1. **Fast:** in the **Privy dashboard**, disable social login methods so only Email/SMS show.
2. **In code (guarantees it regardless of dashboard):** add a `loginMethods` restriction to the
   Privy config in **`redline3d/src/chain/privy-island.ts`** — the `PrivyClientConfig` object
   (the one that currently only sets `embeddedWallets`). Set it to email/SMS only, then rebuild.

**C. Spinner-forever / blank Privy frame (step 6 or 7) — the frame won't load in the WebView.**
This is the real "WebView can't do it" case. Escape hatch = hand login to the phone's **system
browser** (Chrome Custom Tabs), which is a full browser and handles everything.
1. Add the **`@capacitor/browser`** plugin (not currently installed — confirmed absent from
   `redline3d/package.json`).
2. Open Privy's hosted login in a Custom Tab and return to the app via a **deep link**
   (custom URL scheme, e.g. `redline://auth`), registered as an intent-filter in
   `redline3d/android/app/src/main/AndroidManifest.xml` (the app is `singleTask`, so the return
   intent reaches the running activity).
3. This is a **net-new integration**, not a config toggle — treat it as the contingency, not the
   plan-of-record. The plan-of-record is: **email one-time-code inside the in-app panel.**

**D. Perf is choppy at step 11.**
Not a login blocker — a quality issue. Ask Claude to drop the **quality tier** (cap
`pixelRatio`, reduce scene load). There's an existing perf-tier concept in the renderer to lean on.

**E. Worst case — need a login-free build just to capture a demo video.**
The `?wallet=dev` URL trick you use in the desktop Preview **does not work inside the APK** —
the WebView loads a fixed `https://localhost/` with no address bar to add `?wallet=dev` to.
The APK-reachable equivalent is a **build-time pin**: set **`VITE_WALLET=dev`** in `redline3d/.env`
and rebuild. That uses the local dev keypair (pre-funded via `VITE_DEV_SECRET`) and **auto-signs
with no login modal at all** — good for a clean capture, but it bypasses the very thing we're
trying to prove, so only use it if live login is still broken at demo time.
