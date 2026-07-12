# Access Code Recovery and Devnet SOL Crates

## Goal

Keep access codes reachable after a prior redemption and let signed-in players buy Silver and Gold crates with native SOL on Solana devnet.

## Access code behavior

The existing first-access wall remains unchanged for an unredeemed guest or account. Redeemed players continue to enter without repeating the gate. The hamburger menu gains a `Redeem access code` action that opens the same code UI with a close control. This lets a rider who previously used `perpz` later redeem `magic`, and it makes the field recoverable after an APK update preserves local storage.

The menu redemption uses the existing context rules:

- Guests redeem against browser-local state.
- Signed-in accounts redeem against Railway account state with the existing account-scoped fallback.
- Invalid codes grant nothing.
- A code already redeemed for that context reports success without granting twice.

## Devnet SOL crate behavior

The coin purchase buttons stay available. The retired dollar buttons become native SOL buttons only for the paid crate tiers:

- Silver Crate: `0.1 SOL`
- Gold Crate: `0.2 SOL`
- Wooden Crate: coins only

A SOL purchase requires a signed-in connected wallet. The client builds a native System Program transfer from that wallet to `VITE_CRATE_TREASURY_PUBKEY`, signs it through the same cross-platform wallet seam used by game transactions, broadcasts it through the configured devnet RPC, and waits for confirmed finality. Only after confirmation does the existing MagicBlock VRF crate draw run and apply the reward.

Rejected, failed, or unconfirmed transfers grant no reward. A successful transfer followed by a VRF failure remains paid and surfaces a specific retry message; the implementation retains that paid pull in memory so retrying the same crate does not charge a second time during the session.

## Boundaries

`core/crate.ts` owns crate prices. A new devnet SOL payment module owns conversion, transaction construction, broadcast, and confirmation. `ui/cratebox.ts` owns purchase-state UI but receives payment and access as injected ports. `main.ts` wires those ports to the active identity, wallet, treasury, and toast UI.

No server ledger credit, mainnet payment, refund rail, or production receipt index is added in this phase.

## Verification

- Unit tests pin Silver at 0.1 SOL and Gold at 0.2 SOL.
- Transaction tests pin exact lamports, sender, recipient, and confirmation behavior.
- Crate UI tests cover SOL labels, guest blocking, payment failure, successful payment, and no double charge after a paid VRF retry.
- Access UI and menu tests cover the new dismissible redeem action while preserving the first-access hard wall.
- Full client and relevant server suites, production web build, and native APK build run before deployment.
