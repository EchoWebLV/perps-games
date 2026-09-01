# Slopwheels on Robinhood Chain — mainnet design

**Date:** 2026-09-01
**Branch:** `robinhood-mainnet` (cut from `cursor/pyth-hermes-auth-84f1` @ `769bc9c6`)
**Status:** Approved by user 2026-09-01

## Goal

Move Slopwheels' real-money loop from Solana to **Robinhood Chain mainnet** (EVM L2,
chain id **4663**), with the game fully **server-authoritative**:

- Prices: Pyth Hermes consumed **only by the server**, fanned out to clients.
- Economy: existing server Postgres ledger + rounds (already built and green).
- Custody: **EOA treasury** on Robinhood Chain — no Solidity contract in v1.
- Wallets: **Privy EVM embedded wallets**; EIP-191 binding.
- Solana rail: **parked behind flags, code kept** — it returns later.
- MagicBlock ER + VRF: unmounted (Solana-only); crates move to server commit-reveal.
- Markets: crypto feeds now (BTC/ETH/SOL); the feed layer is config-driven so
  equity feeds (TSLA, NVDA, SPY…) are a later config flip, not code.

## Decisions locked with the user

| Decision | Choice |
|---|---|
| V1 on-chain scope | USDC deposit/withdraw rails on RH Chain mainnet |
| Rail architecture | EOA treasury mirroring the proven Solana design (no contract) |
| Crate randomness | Server commit-reveal (VRF returns with Solana) |
| Markets | Crypto now, multi-symbol config so stocks flip on later |
| Branch base | WIP committed on old branch (`769bc9c6`), branch cut from it |

## Chain facts (verified 2026-09-01)

- Mainnet: chain id **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`,
  explorer `robinhoodchain.blockscout.com`, gas token ETH.
- Testnet: chain id **46630**, RPC `https://rpc.testnet.chain.robinhood.com`,
  explorer `explorer.testnet.chain.robinhood.com`.
- Alchemy RPC/WS available with API key (`robinhood-{mainnet,testnet}.g.alchemy.com`).
- Arbitrum Orbit stack; canonical bridge via portal.arbitrum.io (7-day exit to L1).
- Bridged ERC-20 addresses differ from L1 — resolve canonical USDC **on-chain via
  the L2 Gateway Router** (`calculateL2TokenAddress(l1USDC)`), never from a
  third-party list.
- ERC-4337 account abstraction is first-class on the chain (not used in v1).

## Current-state findings the design builds on

1. **Two independent Solana rails exist.** Rail A (server USDC ledger:
   `server/src/{solana,money,services}`, routes `/v1/deposit/*`, `/v1/withdraw`,
   gated by `REAL_MONEY_ENABLED`, loaded via dynamic `import()` in
   `server/src/index.ts:65-147`) has **no UI callers**. Rail B (client on-chain
   SOL + MagicBlock ER: `redline3d/src/chain/*`, cashier `redline3d/src/ui/wallet.ts`
   bound to `game-session.ts`, driven by `main.ts`) is the live money loop and has
   **no flag**. The pivot reuses Rail A's server architecture and unmounts Rail B.
2. **A live Pyth key is committed and shipped in the browser bundle**
   (`redline3d/src/core/feed.ts:47`, commit `1e85e15f`; also `VITE_PYTH_API_KEY`
   in `redline3d/Dockerfile`). The pivot removes the need for it. **Rotating the
   key in the Pyth dashboard is a user action, independent of this work.**
3. Server feed bones exist: `makeHermesFeed` (`server/src/feed/hermes.ts`) does
   SSE streaming with REST poll backstop and advance-based staleness health.
   Feed ids are hardcoded there (BTC/ETH/SOL) and duplicated in
   `redline3d/src/main.ts:336-340` and (pubkey form) `chain/config.ts` /
   `presence/highway-indexer.ts`.
4. Wallet storage is chain-agnostic (`users.walletPublicKey` is `text`) — no DB
   migration needed. The HTTP bind path enforces base58/ed25519 in
   `server/src/auth/wallet-binding.ts` (5 change points); the `bind-wallet.ts`
   CLI validates nothing (divergence to fix).
5. `AppSigner` (`redline3d/src/core/appsigner.ts`) is dead code — the live port is
   `SolanaWalletPort` (`solana-wallet.ts`), selected in `chain/wallet-select.ts`.
6. `deployment-env.test.ts` pins `.env.development` / `.env.production` /
   `Dockerfile` / `build-apk.sh` to agree — it will fail on the first config edit
   by design and must be updated deliberately.
7. `stakeAsset` already flips `"coin"`→`"cash"` off `REAL_MONEY_ENABLED`
   (`server/src/index.ts:32`) — kept as-is.

## Design

### 1. Chain-family seam

- **Server:** new env `CHAIN_FAMILY: "evm" | "solana"` (default `"evm"`). Inside
  the existing `REAL_MONEY_ENABLED` block in `index.ts`, the family selects which
  rail modules are dynamically imported. Solana modules stay in the tree and are
  simply never loaded at `evm`. The existing `superRefine` var-completeness checks
  become family-scoped (Solana vars required only when family is `solana`, EVM
  vars only when `evm`).
- **Client:** new `VITE_CHAIN_RAIL: "evm" | "solana"` gates which wallet port and
  cashier wiring mounts. At `evm`, nothing under `redline3d/src/chain/` that
  touches Anchor/web3.js/ER is imported by the live bundle. `onchain-main.ts`
  remains as the parked Solana harness.

### 2. Server EVM rail — `server/src/evm/`, mirroring `server/src/solana/`

- `deposit-source.ts` — polls `eth_getLogs` for USDC `Transfer(address,address,uint256)`
  events with `to == treasury`, from a cursored block range. Emits the existing
  `InboundTransfer` shape (from-address, amount in cents — USDC is 6 decimals on
  both chains, tx hash as the signature field) so the existing confirmer, cursor
  store, attribution, and quarantine services (`services/deposits.ts`,
  `deposit-worker.ts`, `depositStatus` enum) are reused unchanged.
- `treasury-signer.ts` — viem wallet client on RH Chain; signs ERC-20 `transfer`
  from the treasury EOA. Plugs into the existing `withdraw-worker.ts` +
  `money/idempotency.ts` flow (reserve → admin approve → send → confirm),
  which stays fail-closed exactly as today.
- `chain-status.ts` — transaction receipt + confirmation depth (configurable,
  small N; Orbit chains have fast soft finality).
- RPC: public endpoint primary, `EVM_RPC_URL_FALLBACK` (e.g. Alchemy) secondary —
  same failover pattern as the Solana rail.
- New env (validated together when `REAL_MONEY_ENABLED && CHAIN_FAMILY=evm`):
  `EVM_RPC_URL`, `EVM_RPC_URL_FALLBACK?`, `EVM_CHAIN_ID` (4663 mainnet / 46630
  testnet), `EVM_USDC_ADDRESS`, `EVM_TREASURY_ADDRESS`, `EVM_TREASURY_SECRET`,
  `EVM_CONFIRMATIONS`. Existing chain-neutral knobs (`DEPOSIT_{MIN,MAX}_CENTS`,
  `DEPOSIT_POLL_MS`, `WITHDRAW_*`, `ADMIN_API_SECRET`) apply unchanged.
- Dependency: `viem` (server). No Solidity toolchain.

### 3. Wallet binding — EVM path

- `server/src/auth/wallet-binding.ts`: family-aware. EVM: address must match
  `/^0x[0-9a-fA-F]{40}$/` (stored lowercased), signature verified as EIP-191
  `personal_sign` over the existing HMAC challenge message via viem
  `verifyMessage`. Solana path (base58 + ed25519) kept behind the family switch.
- Client mirror `redline3d/src/core/wallet-binding.ts` updated the same way
  (hex, not base58, on the EVM path).
- `server/src/scripts/bind-wallet.ts` CLI gains address validation for **both**
  families (currently validates nothing).
- No DB migration. Uniqueness index on `walletPublicKey` unaffected.

### 4. Client wallet — Privy EVM + port

- `redline3d/src/chain/privy-island.ts` switches to Privy's **EVM** hooks
  (`useSignMessage`, `useSendTransaction`, embedded EVM wallet
  `createOnLogin: "users-without-wallets"`, `showWalletUIs: false`), with
  Robinhood Chain declared via viem `defineChain` (4663 / 46630, public RPC,
  Blockscout explorer) and passed to Privy's supported+default chain config.
- New `EvmWalletPort` (`connect()`, `signMessage()`, `sendTransaction()`)
  returned by `wallet-select.ts` when `VITE_CHAIN_RAIL=evm`. Dev-keypair port
  gets an EVM twin for local testing (viem `privateKeyToAccount`).
- `redline3d/src/core/appsigner.ts` (dead code) is deleted.

### 5. Cashier rebind — decouple from the ER

- `redline3d/src/ui/wallet.ts` no longer talks to `game-session.ts`:
  - **Balance:** `GET /v1/balance` (server ledger cents).
  - **Deposit:** ERC-20 USDC `transfer` to the treasury address, built client-side
    and sent through the Privy embedded wallet on chain 4663. The server watcher
    attributes it by the bound `from` address and credits the ledger. Min/max
    surfaced from config. Depositors pay their own gas (they hold dust ETH from
    bridging in); this is stated in the UI.
  - **Cash out:** `POST /v1/withdraw` to the bound address (reserve → admin
    approve → treasury send), exactly the existing flow.
- `main.ts`: delegate-on-first-GO and undelegate-on-cashout removed; round flow
  runs purely on the existing server round-sync; `delegated` leaves the cashier
  `status()` shape; ER-specific error codes (`delegate_busy`) removed from the
  player-facing path. (Per the standing no-session-in-player-UI rule, nothing
  session-like reappears.)
- Withdrawal gas is paid by the treasury EOA (it holds ETH).
- ERC-4337 gas sponsorship: **explicitly out of v1.**

### 6. Price feed — server-handled, multi-symbol

- **Server:** `makeHermesFeed` stays. The hardcoded feed-id table moves to a
  config module mapping `symbol → { hermesId, display }`, loaded from code (not
  env) but structured so adding equity symbols later is a one-file change.
  `PYTH_API_KEY` remains server-only.
- **New WS fan-out:** `/v1/feed` on the existing `@fastify/websocket` server
  (same infra as `/v1/presence`): broadcasts `{ symbol, price, publishTime }`
  ticks to all connected clients on each feed advance. No auth required for
  price ticks (public data). Backpressure: drop-oldest per socket; a slow client
  only hurts itself.
- **Client:** `redline3d/src/core/feed.ts` rewritten: primary = server WS
  `/v1/feed` with reconnect/backoff; fallback = existing `GET /v1/prices`
  polling when the WS is down. **Removed entirely:** Lazer WS endpoints, direct
  Hermes SSE/REST, the baked token constant, `VITE_PYTH_API_KEY` (including the
  Dockerfile build ARG), and the duplicated feed-id tables in `main.ts` (client
  keeps display symbols only; ids are server business).
- Staleness: server keeps advance-based health; when the feed is stale the server
  holds round settlement (existing behavior) and the client HUD shows its
  existing degraded state.

### 7. Crates — server commit-reveal

- Server crate service: before a pull, server generates `seed`, stores it, and
  returns `commitment = sha256(seed ‖ nonce)` to the client; the roll derives
  from `seed`; after the pull the server reveals `seed`/`nonce` so anyone can
  recompute both the commitment and the roll. Odds curve (50/28/14/6/2) and
  crate tiers unchanged. Commitments and reveals are persisted with the pull
  record.
- Client `redline3d/src/ui/cratebox.ts` drops MagicBlock VRF calls
  (`CRATE_ROLL_PROGRAM_ID` path); reveal cinematics and the all-prizes reveal
  stay. The welcome-crate once-per-account rule is untouched (already server-side).

### 8. Parked (kept in tree, unmounted)

- `redline3d/src/chain/` ER session + Anchor deps (unreachable at `evm`).
- `server/src/solana/` modules (never imported at family `evm`).
- MagicBlock VRF crate path; highway-indexer (already env-flagged, stays off).
- Lazer client code is deleted, not parked (the server feed replaces it; history
  has it if needed).

## Error handling

- Unknown-sender deposits → existing quarantine status; recoverable by later bind.
- RPC failure → primary/fallback failover; deposit cursor guarantees no missed
  blocks (resume from last processed block).
- Reorg safety: deposits credit only after `EVM_CONFIRMATIONS` depth.
- Withdrawals stay fail-closed: no processor or no admin secret → 503, funds
  never leave without the reserve+approve pair.
- Idempotency: existing key scheme keyed off the withdrawal id; the EVM sender
  additionally serializes on the treasury nonce (single worker, as today).
- WS feed drop → client auto-falls back to `/v1/prices` polling and recovers.

## Testing & mainnet gate

TDD throughout (repo norm). New/updated coverage:

1. `server/src/evm/*.test.ts` — log decoding, cursoring, confirmation depth,
   transfer building/signing, idempotent sends (mirror the 6 Solana test files).
2. EIP-191 binding: fixture vectors (known key → address → signature), bad-family
   / bad-checksum / replayed-challenge rejections; CLI validation both families.
3. Feed: WS fan-out broadcast + slow-client drop test; client feed fallback test.
4. Crates: commit-reveal roundtrip (commitment verifies, roll reproducible,
   reveal only after pull).
5. Cashier/main rebind tests updated; ER-coupled tests moved behind the parked
   flag or retired with the mounting they covered.
6. `deployment-env.test.ts` updated deliberately alongside env/Dockerfile edits.

Gate order (all must pass in order):

1. Full suites green: `server` (vitest), `redline3d` (vitest + `tsc`), engine.
2. **Testnet 46630 live e2e:** real USDC-test deposit lands in ledger to the
   cent; real withdraw returns on-chain to the cent; crate pull verifies
   commit-reveal. Same bar as the Solana rail's proven e2e.
3. Mainnet flip: fresh treasury EOA (new secret, never the dev one), funded with
   gas ETH; `EVM_USDC_ADDRESS` router-verified; Privy app configured for 4663;
   Railway env updated (`CHAIN_FAMILY=evm`, EVM vars, Solana vars removed from
   the running service); client built without any Pyth key.
4. Live browser verification on production before calling it done (standing rule).

## Explicitly not in v1

- Equity/stock feeds (config flip later — the feed layer is built for it).
- ERC-4337 gas sponsorship / paymasters.
- Vault smart contract.
- Solana rail return (it's parked, not scheduled).
- $SLOP token anything (still shelved).
- Pyth key rotation (user's dashboard action — flagged, not code).
