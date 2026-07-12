# Driver Name Flow Design

**Date:** 2026-07-12

## Goal

Every Highway car must have a driver name the player knowingly chose. Existing and returning players need an obvious place to view and edit that name. Signed-in names must follow the Railway account across browsers and devices; guest names remain local practice identity.

## Product behavior

- Add a **Driver Name** row to the account section of the main menu. Its subtitle shows the current name or `choose your name`.
- Tapping the row opens a focused name dialog with the current name prefilled, the existing `3-16 characters: letters, numbers, underscores` rule, Save, and Cancel.
- Driver names are normalized to lowercase and are not unique. They are social display labels, not account identifiers.
- A guest already chose a name at the first-launch identity gate. Editing updates local identity immediately.
- A signed-in account uses the Railway profile name as truth. Editing saves to Railway, then updates local identity and presence.
- Legacy signed-in accounts with no Railway profile name may continue using the existing generated `rider_xxxx` label outside Highway, but must confirm or replace it before entering Highway for the first time.
- After a required Highway prompt saves successfully, the app continues into Highway automatically. Cancel leaves the player in the lobby.
- The existing public-host Highway `Coming soon` gate runs first. Public Railway visitors are not asked for a name for a building they cannot enter.

## Alternatives considered

1. **Railway-backed account name plus local guest name, recommended and approved.** Works across devices, gives presence one durable source of truth, and remains simple because names need not be unique.
2. **Browser-only name for everyone.** Faster initially, but signed-in players would change names when switching devices or clearing storage and would not feel like real accounts.
3. **Immutable wallet-derived name.** Requires no UI, but directly repeats the current problem: the player never chooses how their car is identified.

## Architecture

### Server profile field

Add nullable `users.driver_name` through migration `0016`. Nullable distinguishes a legacy/unconfirmed account from a player-selected name. The server validates and normalizes every write with the same rule as the client: trim, lowercase, and match `^[a-z0-9_]{3,16}$`.

Extend `GET /v1/me` with `driverName: string | null`. Add `POST /v1/profile/driver-name` with `{ name }`, protected by the existing authenticated-user middleware. The response is `{ driverName }`. The endpoint may update the name repeatedly and does not require wallet binding because the field is non-financial profile data.

### Client profile state

Extend the client API types and account hydration path to receive `driverName`. When Railway returns a non-null name, replace the local signed-in identity name and reconnect presence so nameplates use the account value.

Keep a small runtime `accountDriverName` state sourced from `/v1/me`. A signed-in name is confirmed only when this value is non-null. Guest identity names are confirmed by construction because the guest door already requires a valid name.

### Name dialog

Create a dedicated `createDriverNameDialog` UI module rather than reusing the first-launch identity gate. The dialog has one purpose and never shows guest/sign-in/logout controls.

The dialog receives:

- current name;
- an async save callback;
- cancel behavior;
- optional copy explaining that Highway requires a name.

It owns client validation, busy state, inline errors, Enter-to-save, keyboard-event suppression, and focus restoration. Server errors keep the dialog open and show `Couldn't save your driver name. Try again.`

### Menu integration

Extend the garage/menu configuration with a driver-name action and dynamic driver-name info. Render the row in the existing account section above Sign in/Log out. Opening the menu refreshes its subtitle from current identity state.

Saving from Settings:

- guest: update and save local identity, then reconnect presence;
- signed in: call Railway first; only after success update local identity, save it locally as a boot cache, and reconnect presence.

### Highway entry guard

In the Highway building branch:

1. Check public-host availability. If unavailable, show `Highway coming soon` and stop.
2. Check whether a driver name is confirmed.
3. If confirmed, enter Highway normally.
4. If unconfirmed, open the driver-name dialog. A successful save calls the same Highway entry function; Cancel stays in the lobby.

This guard affects only Highway. Track, Garage, Crates, Upgrades, and Scrapyard behavior does not change.

## Presence behavior

Presence already reads `identity.name`, and remote car nameplates already react when a player's name changes. After a save, reconnecting presence republishes the selected name. No presence protocol change is required.

## Failure and compatibility behavior

- A failed Railway save never changes the signed-in local name and never enters Highway.
- Offline guests can rename normally because their identity is local practice state.
- Returning signed-in players retain the cached name while account hydration is pending. Highway entry waits for an explicit save only when Railway has confirmed the profile name is null.
- Existing valid local identities remain readable. No localStorage migration is required.
- Names are not reserved or unique in this version. Moderation, cooldowns, and uniqueness are outside scope.

## Testing

- Server service tests: normalization, repeated updates, invalid names, and account isolation.
- Route tests: authentication, response shape, validation failures, and `/v1/me` returning `driverName`.
- Client API tests: profile endpoint and `MeResult` field.
- Dialog tests: prefill, validation, Save, Cancel, busy/error behavior, and Enter handling.
- Menu tests: Driver Name row appears and invokes the supplied action.
- Main integration test: public Highway remains `Coming soon`; confirmed names enter; unconfirmed signed-in accounts open the dialog and continue only after save.
- Existing presence tests remain unchanged because the protocol already transports names.

## Out of scope

- Globally unique handles.
- Profanity filtering or moderation tooling.
- Paid renames or rename cooldowns.
- On-chain storage of display names.
- Changing wallet identity, account ownership, or financial authorization.
