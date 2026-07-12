# Account-scoped tutorial completion

## Problem

The tutorial currently stores completion under one device-global key, `raider.howto.v1`.
After one player completes the tutorial, signing out and choosing a different Privy account on the
same browser or phone skips the tutorial for that new account.

The account-switch flow itself is working: after authentication, hydration, and any access-code
wall, it calls the tutorial flow. The global completion flag incorrectly reports that the new
account has already seen it.

## Required behavior

- Each signed-in Privy account sees the tutorial automatically once.
- Signing out and signing in with a different account shows the tutorial for the new account.
- Returning to an account that already completed or skipped the tutorial does not show it again.
- Guests continue to share one device-local tutorial completion flag.
- The tutorial remains manually replayable from the existing menu.
- Tutorial completion stays local to the device. No Railway schema or API change is required.
- The existing access-wall, welcome-crate, save-vault, and reload ordering remains unchanged.

## Design

Extend the tutorial flag helpers to accept an optional identity namespace:

- Guest namespace: keep the existing `raider.howto.v1` key.
- Signed-in namespace: use `raider.howto.v1:<wallet-address>`.

The wallet address is available from `session.address()` after a successful sign-in or reconnect,
which is exactly when the signed-in tutorial flow runs. The main application will pass that address
verbatim to both the read and write operations. Solana addresses are case-sensitive and must not be
lowercased. Guest flows will omit the namespace and preserve the current device-local behavior.

Existing global completion does not grandfather signed-in accounts. On the first run after this
change, each account without its own namespaced flag receives the tutorial once. This is intentional:
it repairs the current ambiguity and guarantees the requested per-account behavior.

## Data flow

1. A guest clears the local access wall and enters the tutorial flow without a namespace.
2. A signed-in account authenticates and hydrates from Railway.
3. The access wall clears or is skipped.
4. The tutorial flow reads the namespaced key for `session.address()`.
5. If unseen, the overlay opens and writes that same namespaced key when closed or skipped.
6. The existing welcome-gift callback runs afterward.

## Error handling

The existing safe local-storage behavior remains. If storage is unavailable, the flag cannot be
persisted, so the tutorial may appear again on a later visit. The tutorial must never block the app
because storage throws.

An empty namespace falls back to the guest/device key. Signed-in callers only supply the wallet
address after authentication has succeeded.

## Testing

- Unit-test that the base guest key remains once per device.
- Unit-test that two different wallet namespaces are independently unseen and marked.
- Unit-test that separate case-sensitive wallet namespaces remain independent.
- Add a main-wiring regression test proving signed-in entry reads and writes using
  `session.address()`, while the guest path remains unscoped.
- Run the focused tutorial tests, TypeScript/Vite build, and full client test suite.
- Build and install the APK on the connected Seeker, verify a clean native launch, and deploy the
  committed web client to Railway.

## Out of scope

- Synchronizing tutorial completion across devices.
- Changing tutorial content, media, or navigation.
- Changing account access codes, welcome crates, or save ownership.
