# Account Trade History and Production Menu Design

## Goal

Add an account-wide History screen for signed-in on-chain trades, while showing the Garage and Upgrades hamburger-menu rows only on the local browser development server.

Practice runs are excluded. The on-chain Raider round remains the source of truth for balances, payouts, and settlement. Server trade history is a display record and must never drive money, rewards, progression, or entitlements.

## Product Behavior

### Menu visibility

- History appears in the hamburger menu on web, native app, production, preview, and local development builds.
- Garage and Upgrades appear in the hamburger menu only when all three conditions are true:
  - Vite is running in development mode.
  - The page is not running inside a Capacitor native shell.
  - The hostname is a loopback host: `localhost`, `127.0.0.1`, or `::1`.
- A Capacitor WebView may itself use `localhost`, so hostname alone is not a safe app-versus-browser test.
- This change hides only the two hamburger-menu rows. It does not remove the Garage or Upgrades buildings, modules, or underlying local development functionality.

### History screen

- The screen opens from a new History menu row.
- A signed-out or guest player sees a clear sign-in-required state. Practice runs are never listed or uploaded.
- A signed-in player sees newest trades first.
- Each row shows:
  - Local date and time.
  - Asset.
  - Opening LONG or SHORT direction.
  - Opening leverage.
  - Stake in SOL.
  - Entry and exit prices.
  - Settlement outcome.
  - Payout and signed profit or loss.
- The first page contains 25 trades. A Load more action follows a server cursor until every stored trade is reachable.
- Empty, loading, retryable error, and end-of-history states are explicit.
- History starts with trades recorded after this feature is deployed. Reconstructing older Ephemeral Rollup event history is outside this design and requires a separate on-chain indexer.

## Architecture

### Local menu policy

Create a small pure environment-policy function that accepts the Vite development flag, hostname, and Capacitor-native flag. `main.ts` evaluates the real runtime values and passes the resulting boolean into `createCarPicker`. The car picker conditionally creates the Garage and Upgrades rows, while always creating History.

Keeping the policy pure makes the important Capacitor-on-localhost case directly testable.

### Trade history storage

Add a dedicated `trade_history` PostgreSQL table rather than reusing the legacy REST `rounds` table. The active game settles through the on-chain Raider session, while the existing `rounds` table represents a different server-settlement path. Mixing them would make the source of a record ambiguous.

Each stored record contains:

- Client-generated UUID used as the idempotency key.
- Authenticated server user ID.
- Server-derived bound wallet public key.
- Asset.
- Opening direction and leverage.
- Stake base units.
- Entry and exit display prices.
- Oracle/open timestamp when available.
- Outcome.
- Payout base units.
- Server settlement-record timestamp.

Profit or loss is derived as `payoutBase - stakeBase`; it is not accepted as an independent client field.

The record is intentionally display-only. Server code that reads trade history is not imported by ledger, withdrawal, reward, inventory, upgrade, or settlement services.

### Server service and API

Add a focused trade-history service with two operations:

- `record(userId, input)`: inserts once by UUID, derives the wallet from the authenticated user, and returns the existing row on an idempotent retry.
- `list(userId, cursor, limit)`: returns only that user's records, newest first, using a stable `(settledAt, id)` cursor.

Expose authenticated endpoints:

- `POST /v1/trades`
- `GET /v1/trades?cursor=<opaque>&limit=25`

Input validation permits only supported assets and outcomes, direction `1` or `-1`, bounded leverage, positive safe-integer stake, nonnegative safe-integer payout, finite positive prices, and a UUID idempotency key. The wallet is never accepted from the request body.

### Client recording flow

At confirmed on-chain open, create an in-memory active-trade draft containing the UUID, asset, opening direction, opening leverage, stake, entry price, and open timestamp.

Every authoritative settlement path already converges on `finalizeSettled`. Extend its settled payload with the exit price needed for display. When `finalizeSettled` receives a confirmed result:

1. Complete the active draft with outcome, payout, and exit price.
2. Enqueue it in a small wallet-scoped local outbox.
3. Clear the active draft so duplicate terminal callbacks cannot create another record.
4. Flush the outbox through the authenticated API without delaying or changing settlement UI.

The outbox keeps a failed upload across reloads and retries after account synchronization and whenever History opens. Successful records are removed. The server UUID constraint makes a lost response and retry harmless.

Guest practice settlement does not create a draft, enqueue an item, or call the trade API.

The client-supplied display record can be tampered with by a modified client. That limitation is accepted because the history has no economic authority. A future indexer can replace the write source while preserving the database read API and History UI.

### History UI

Create a separate `createTradeHistory` UI module rather than adding data-fetching responsibilities to the already large car-picker module. Its public interface is limited to `open`, `close`, and `isOpen`.

The car picker receives an `onHistory` callback. Selecting History closes the menu through the existing chained-overlay path and opens the History panel. The global GO launch guard includes `history.isOpen()` so a keyboard shortcut cannot start a wager behind it.

The panel follows the existing neon overlay visual language and uses native buttons for close, retry, and pagination. The list itself remains readable on narrow portrait screens and scrolls independently from the world.

## Error Handling

- A history upload failure never changes or delays an on-chain payout.
- Failed uploads remain in the local outbox and retry later.
- Opening History flushes pending records before loading the newest server page.
- A failed list request shows an inline error and Retry action without closing the panel.
- An expired authentication session shows a sign-in-required state.
- Malformed trade submissions are rejected with `400`; unauthenticated requests with `401`.
- Duplicate UUID submissions return the existing record rather than creating duplicates.

## Testing

### Client

- Environment policy covers local Vite, production, preview, non-loopback development hosts, and Capacitor using `localhost`.
- Car-picker DOM tests prove Garage and Upgrades are conditional and History is always present.
- History UI tests cover loading, empty, populated, error/retry, and pagination states.
- Trade recorder tests cover draft completion, outbox persistence, retry, idempotent removal, account/wallet scoping, and practice exclusion.
- Main integration tests prove a confirmed signed-in settlement enqueues once and a practice settlement never enqueues.
- GO keyboard blocking includes an open History panel.

### Server

- Service tests cover idempotent insertion, derived wallet identity, newest-first cursor pagination, and user isolation.
- Route tests cover authentication, validation, duplicate submission, and attempts to read another user's records.
- Migration/runtime tests include the new table and indexes.

### Verification

- Run focused client and server tests during development.
- Run full client and server suites, TypeScript builds, and the production client build.
- Browser-check localhost menu visibility, History states, pagination, and keyboard blocking.
- Build or inspect the production bundle to confirm Garage and Upgrades rows are absent at runtime while History remains present.

## Non-Goals

- Backfilling trades that occurred before this feature.
- Building a MagicBlock or Solana event indexer.
- Using history for balances, rewards, achievements, leaderboards, tax reporting, or dispute resolution.
- Removing the Garage and Upgrades buildings or their implementation.
- Recording guest practice runs.
