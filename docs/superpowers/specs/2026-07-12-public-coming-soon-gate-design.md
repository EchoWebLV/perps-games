# Public Coming Soon Gate

## Goal

Prevent the game from running on Railway or any other public hostname while preserving full local development access.

## Host policy

The game may boot only when `location.hostname` is one of:

- `localhost`
- `127.0.0.1`
- `::1`
- `[::1]`

Every other hostname is public and must receive the Coming Soon experience. There is no query-string, path, storage, or environment-variable bypass.

## Boot architecture

`index.html` owns the gate because it runs before the application module. A small inline boot script evaluates the hostname.

- Local host: dynamically append the `/src/main.ts` module script and retain the existing loading splash.
- Public host: remove the loading splash, hide the game canvas and HUD, render a full-screen Coming Soon screen, and never append the game module script.

Because `main.ts` is never loaded publicly, wallet initialization, API calls, WebSockets, price feeds, rendering, and gameplay cannot start underneath the message.

## Coming Soon screen

The public page uses the existing dark neon visual language and contains only:

- `PERPS RAIDER`
- `COMING SOON`

It has no buttons, login controls, navigation, or bypass affordances.

## Testing

Automated tests will cover:

- Exact loopback hostname allowlist behavior.
- Railway and arbitrary public domains being blocked.
- The HTML entrypoint containing no unconditional `main.ts` module tag.
- The local branch being the only branch that appends the game module.

A production build must still succeed. Browser verification will confirm localhost loads the game and a simulated public hostname renders only Coming Soon without requesting `main.ts`.

## Non-goals

- Changing the Railway server, database, or API availability.
- Adding invite codes or preview bypasses.
- Changing Capacitor packaging beyond the hostname rule. Capacitor's localhost WebView remains allowed because it uses a loopback hostname.
