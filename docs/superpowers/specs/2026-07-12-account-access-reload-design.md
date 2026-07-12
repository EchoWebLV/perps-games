# Account Access Reload Design

## Problem

After logging out, signing into a different Privy account, and redeeming an access code, the access wall resumes the already-running scene. That scene was initialized across the account transition and can render black until the app is restarted manually.

## Design

After a signed-in access-code redemption resolves as `granted` or `already`, reload the app immediately. Redemption completes first, so the server or account-scoped fallback records access before navigation. On the next boot, hydration sees the redeemed code and skips the wall, then runs the normal how-to and welcome flow using fresh account state.

Already-authorized accounts do not reload because they bypass the wall. Guest redemption remains unchanged and continues in place.

## Verification

- The signed-in access-wall callback must reload instead of continuing the stale scene.
- The pre-authorized account bypass must still call its continuation without reloading.
- Guest access must not reload.
- Client tests and production build must pass.
- The rebuilt APK must be installed on the connected Seeker.

