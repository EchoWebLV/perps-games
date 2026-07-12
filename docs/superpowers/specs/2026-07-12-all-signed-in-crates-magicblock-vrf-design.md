# All Signed-In Crates Use MagicBlock VRF

## Goal

Every crate that grants a reward to a signed-in account must use MagicBlock VRF. This includes the once-per-account Wooden welcome crate and every paid crate. Guest practice crates may continue using browser randomness because guests have no signing wallet and their state is not account-backed.

## Required Behavior

- A signed-in welcome crate always requests MagicBlock VRF randomness.
- A signed-in paid crate always requests MagicBlock VRF randomness.
- A signed-in crate never falls back to browser randomness when the wallet, RPC, or oracle is unavailable.
- An unfunded wallet keeps the welcome crate pending and shows a funding message.
- A failed or timed-out VRF request keeps the welcome crate pending.
- Refreshing or signing in again offers a still-pending welcome crate again.
- The server completes the once-per-account welcome claim only after VRF randomness is available.
- Guest practice crates remain the only client-RNG path.

## Current Problem

`createCrateBox` currently disables VRF whenever an open is free. The signed-in welcome flow also calls `POST /v1/welcome/claim` before opening the crate. That endpoint atomically changes `welcome_claimed` from false to true. If VRF were simply enabled in the current order, an unfunded wallet or oracle timeout would consume the claim without delivering a reward.

## Chosen Design

Use a preflight status read and delay the existing atomic claim until after randomness succeeds:

1. The signed-in client reads welcome eligibility without mutating it.
2. If the claim is pending, the client opens the welcome crate UI.
3. The client requests four draws through the existing `crate_roll` MagicBlock VRF path.
4. If VRF fails, the UI reports the error and the server claim remains untouched.
5. If VRF succeeds, the client calls the existing atomic welcome-claim operation.
6. Only a successful claim is allowed to map the VRF draws into a reward and reveal it.
7. If another tab completed the claim first, the losing tab discards its randomness and grants nothing.

This order preserves retryability without a database migration. It also retains the current compare-and-set protection for exactly one successful welcome claim per account.

## Components

### Railway welcome status

Add a wallet-bound, read-only welcome-status operation. It returns whether the account's welcome claim is pending or already claimed. It must not modify `welcome_claimed`.

The existing claim endpoint remains the atomic false-to-true transition and the final concurrency gate.

### Client API

Expose the welcome-status read separately from the existing claim mutation. The startup flow uses status to decide whether to show the gift. It no longer consumes the claim before opening the crate.

### Crate box randomness policy

Replace the current free-versus-paid decision with an explicit account policy:

- Guest: client RNG is permitted.
- Signed-in account: VRF is required for both free and paid crates.

The crate box must fail closed when VRF is required but no provider is available. It must not enter the synchronous RNG branch.

### Welcome completion callback

The signed-in welcome open receives an asynchronous completion gate. After VRF returns draws, this gate performs the atomic server claim. Reward mapping, inventory mutation, scrap mutation, level unlocks, and reveal happen only after that gate succeeds.

Paid crates retain the existing hold, VRF request, commit-or-release flow.

### Wallet funding behavior

The application does not sponsor the welcome transaction. If the embedded wallet lacks devnet SOL, the VRF transaction fails with the existing wallet-funding message. The claim remains pending, and the user can retry after funding.

## Data Flows

### Signed-in welcome crate

```text
login
  -> GET welcome status
  -> pending
  -> show Wooden welcome crate
  -> request MagicBlock VRF
  -> wait for matching RollSlot nonce
  -> POST atomic welcome claim
  -> map verified bytes to four draws
  -> grant/reveal reward
```

Failure before the atomic claim leaves the welcome reward pending.

### Signed-in paid crate

```text
hold coins
  -> request MagicBlock VRF
  -> wait for matching RollSlot nonce
  -> commit coin hold
  -> map draws
  -> grant/reveal reward
```

Failure releases the coin hold and grants nothing.

### Guest crate

```text
guest practice open
  -> browser RNG
  -> local practice reward
```

No signed-in or account-backed flow may enter this branch.

## Concurrency

Two clients may read the welcome status as pending and both pay for a VRF request. The existing atomic claim allows only one client to proceed to reward mapping and reveal. The other receives `welcome_already_claimed`, discards its draws, and grants nothing. This can waste one VRF request but cannot duplicate the welcome reward.

## Error Handling

- Missing signed-in VRF provider: show a connection error and grant nothing.
- Unfunded wallet: show the existing devnet SOL funding message and leave the claim pending.
- VRF timeout: show the existing oracle timeout message and leave the claim pending.
- RPC or transaction failure: show the generic VRF failure message and leave the claim pending.
- Welcome claim conflict after VRF: close the gift flow without granting a reward because another client already completed it.
- Server unavailable after VRF: grant nothing and leave the server claim pending so the player can retry later.
- Paid crate failure: release held coins and grant nothing, matching current behavior.

## Testing

### Client unit tests

- A free signed-in welcome crate selects VRF when a provider exists.
- A signed-in welcome crate never falls back to client RNG when the provider is missing.
- A guest crate may use client RNG.
- Welcome completion is called after VRF succeeds and before any reward mutation.
- A rejected completion grants no car, scrap, or level.
- VRF failure does not call welcome completion.
- Paid crate hold behavior remains unchanged.

### Server tests

- Welcome status reports pending before claim.
- Welcome status reports claimed after claim.
- Welcome status requires a wallet-bound account.
- Reading status does not consume the claim.
- The existing concurrent/duplicate claim behavior remains a conflict after the first success.

### Verification

- Run targeted client crate and welcome tests.
- Run targeted Railway user and account-route tests.
- Run the complete client and server test suites.
- Run client and server production builds.

## Non-Goals

- Sponsoring VRF transaction fees.
- Moving crate odds or inventory into the `crate_roll` program.
- Making Railway independently verify the RollSlot or recompute rewards in this change.
- Changing paid crate prices or odds.
- Removing guest practice mode.

## Trust Boundary

This change guarantees that all signed-in crate randomness comes through MagicBlock VRF and removes the signed-in browser-RNG fallback. The inventory grant remains part of the existing client and Railway synchronization model. End-to-end server verification of the on-chain RollSlot is a separate hardening project.
