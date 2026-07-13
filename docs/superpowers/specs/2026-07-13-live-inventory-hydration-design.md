# Live Inventory Hydration Design

## Problem

The Garage is constructed before a fresh account signs in. At that point, each car's `locked` flag and card markup are derived from the starter inventory. Server hydration later replaces and persists the inventory counts, but it does not reconcile the already-constructed car definitions or Garage cards. The account data is correct after hydration, while the live Garage remains stale until a restart rebuilds it from the persisted inventory.

## Approaches Considered

1. Reload after every successful sign-in. This would rebuild the Garage correctly, but it would add a disruptive reload to a flow that is designed to continue in the warmed scene.
2. Call the existing one-way `garage.grant()` method for every hydrated car. This would unlock newly owned cars, but it could not re-lock cars removed by server-authoritative hydration and would leave the UI inconsistent after account switches.
3. Add a full Garage ownership reconciliation API. This is the selected approach because it supports both locked-to-owned and owned-to-locked transitions without reloading the scene.

## Design

`createCarPicker` will expose a `reconcileOwnership(owns)` method. The callback receives a car name and returns whether the hydrated inventory owns it. For every car, the method will derive the desired `locked` value using the same pullability rule used at boot:

```ts
const locked = poolable(car) && !owns(car.name);
```

Only cards whose lock state changed will be repainted. If any card changed, the static Garage art cache will be invalidated so newly available car art can be rendered the next time the Garage opens. Existing `comingSoon` and non-pullable behavior remains unchanged.

If reconciliation locks the currently equipped car, the Garage will immediately select the first available, non-coming-soon car and invoke the existing `onPick` callback. This prevents an account switch from leaving a player equipped with a car that the new account does not own.

The account synchronization callback will continue to hydrate the inventory first, then call:

```ts
garage?.reconcileOwnership((name) => inventory.owns(name));
```

Because account synchronization is declared before the Garage is constructed, the integration will use a nullable Garage reference that is assigned immediately after `createCarPicker` returns. Hydration can safely occur before assignment, and the boot-time lock derivation remains the fallback for that ordering.

## Data Flow

1. Privy sign-in binds the wallet-backed account.
2. Railway returns the authoritative inventory snapshot.
3. `inventory.hydrate()` replaces counts and persists them locally.
4. `garage.reconcileOwnership()` updates live car definitions and changed cards.
5. Opening the Garage immediately shows the signed-in account's collection.

## Correctness Requirements

- A server-owned car that was locked before sign-in becomes available immediately without restart.
- A car absent from the server snapshot becomes locked immediately, preserving server-wins semantics during account switches.
- If the currently equipped car becomes locked, selection falls back to the first available car.
- Free, non-pullable, benched, and coming-soon cars preserve the existing boot rules.
- Reconciliation fires no inventory grant or melt hooks and therefore produces no duplicate server writes.
- The existing crate unlock path through `garage.grant()` continues to work.

## Testing

Add focused `createCarPicker` tests for both lock directions:

- locked to owned after reconciliation;
- owned to locked after reconciliation.
- equipped owned car to locked, with fallback selection.

Add a source-level integration assertion that account hydration invokes Garage reconciliation after `inventory.hydrate()`. Then run the focused Garage tests, the full client suite, TypeScript checking, and the production build.

## Scope

This change fixes the live Garage view only. It does not alter server inventory semantics, authentication, persistence formats, crate probabilities, or account migration behavior.
