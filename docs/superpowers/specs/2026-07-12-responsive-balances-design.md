# Responsive Balance Updates

## Goal

Make the displayed total SOL balance react immediately after a confirmed crate purchase or an authoritative race settlement.

## Design

The UI maintains the last known wallet SOL and the session's known play balance. It renders their sum through one shared function.

- After a crate transfer confirms, subtract its exact SOL price from the known wallet balance and render immediately.
- When a settlement response contains the new play balance, store that balance in the game session and render immediately.
- Continue reading wallet and play balances from RPC in the background. Those reads reconcile the optimistic display with chain truth.
- Rejected or unconfirmed crate transactions do not change the display.
- A balance is never inferred before transaction confirmation.

## Failure Handling

An RPC failure leaves the latest confirmed display intact. A later successful refresh replaces it with authoritative chain state. Values are clamped so temporary arithmetic cannot show a negative wallet balance.

## Testing

- Unit-test confirmed wallet-spend arithmetic.
- Verify background lever and flip settlements update the session's cached balance.
- Source-level integration tests require immediate rendering after crate confirmation and settlement.
- Run the full frontend test suite and production build before deployment.
