# Capacitor CORS Fix Design

## Problem

The Android APK runs its WebView from `https://localhost`. The production server's CORS allowlist includes browser localhost origins and `capacitor://localhost`, but not `https://localhost`. Android therefore blocks `POST /v1/session`, preventing the presence client from obtaining a bearer token and leaving the lobby status at `LIVE OFFLINE`.

## Design

Add `https://localhost` and `capacitor://localhost` to the server's default CORS origins, and ensure Railway production contains both native origins. Keep the exact-origin allowlist model rather than allowing every origin. No client or APK change is required.

## Verification

- A server environment test must assert both native origins are present by default.
- A production preflight from `Origin: https://localhost` must return `Access-Control-Allow-Origin: https://localhost`.
- After restarting the installed app, Seeker logs must not contain a new CORS failure for `/v1/session`.
- The lobby presence indicator must progress beyond `LIVE OFFLINE` when the app has an identity and network access.

