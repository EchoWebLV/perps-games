# Sign-In Gate Hierarchy Design

**Date:** 2026-07-13

## Goal

Make account sign-in the unmistakable primary action on the first-launch identity gate while keeping guest practice mode visible and easy to choose.

## Current Problem

The gate currently assigns the bright green arcade CTA to `RIDE AS GUEST` and renders `SIGN IN` as a dark secondary panel. This visual hierarchy promotes guest mode even though signed-in play is the full experience with saved progress, car collection, and real-SOL play.

## Approved Experience

- Render `SIGN IN` first as the large glowing green arcade CTA.
- Explain the benefit directly below it: `save progress · collect cars · play for real SOL`.
- Render `RIDE AS GUEST` second as a smaller dark outlined button.
- Explain guest mode directly below it: `practice mode · no wallet required`.
- Clarify the driver-name requirement: the name is optional for sign-in and required for guest mode.
- Keep both options visible without hiding guest mode behind a text link or another screen.

## Behavior

No identity behavior changes:

- Sign-in may continue with an empty driver-name field and calls `onSignIn(null)`.
- A typed sign-in name must still pass the existing validation rule.
- Guest mode still requires a valid driver name before `onGuest` runs.
- Busy, error, dismiss, focus, and keyboard behavior remain unchanged.

## Visual Direction

The primary sign-in action reuses the existing `.cta` synthwave treatment so it matches important game actions. Guest mode uses a lower-contrast panel with a thin cyan border, smaller type, and no green glow. Focus-visible and disabled states must remain obvious on keyboard and touch devices.

The card keeps the current neon title, centered name field, and concise driving instruction. Supporting copy is split so each explanation sits next to the action it describes.

## Alternatives Considered

1. **Primary sign-in CTA plus secondary guest button, approved.** Strong hierarchy while keeping both choices easy to find.
2. **Guest mode as a text link.** More aggressive, but too easy to miss and less transparent.
3. **Two equal action cards.** Clear but fails to make sign-in more prominent.

## Testing

- Add a DOM test proving sign-in appears before guest mode and owns the primary `.cta` style.
- Assert the approved benefit and guest-mode copy is present.
- Add regression coverage proving empty-name sign-in remains allowed and guest mode still requires a valid name.
- Run the focused identity test, the full client test suite, and the production web build.
- Build the Android APK, install it on the connected Seeker, publish the identical APK to the website download route, and deploy the web build to Railway.

## Out of Scope

- Changes to Privy authentication, wallet creation, account persistence, or guest practice mechanics.
- Hiding or removing guest mode.
- Changes to the landing page, game economy, or on-chain programs.
