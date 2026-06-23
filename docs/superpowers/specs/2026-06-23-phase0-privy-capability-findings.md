# Phase 0 Capability Spike — Static Findings (Privy server-wallet, Solana custody)

**Spec:** `docs/superpowers/specs/2026-06-23-real-money-rails-design.md` (§5 deposit, §6 withdraw, §7 idempotency, §9 custody policies, §14 phasing)
**SDK under test:** `@privy-io/node@0.22.0` (installed; `node_modules/@privy-io/node/package.json` → `"version": "0.22.0"`)
**Date:** 2026-06-23

## Purpose

This document is the **STATIC half of Phase 0** (spec §14, the GATING phase). It verifies the spec's assumed Privy server-wallet capabilities **against the installed `@privy-io/node@0.22.0` TypeScript type definitions** — file-and-line evidence, exact method signatures, and discriminated-union shapes. A static pass means "the type surface exists and is callable with the assumed arguments"; it does **not** prove on-chain or backend runtime semantics. The **EMPIRICAL half of Phase 0 still requires a live Privy staging app + app-secret credentials** and is captured in the staging checklist at the end. Per spec §14, no deposit (Plan 2) or withdraw (Plan 3) implementation plan may be finalized until the gating empirical tests below pass. Every capability here was checked against the SDK that is actually in `node_modules`, not against published docs. The two HARD blockers and the soft blocker were independently spot-verified by the controller (aggregations empty class + ETH-only method enum; intents has no `authorize()`/`execute()`; `sponsor` is USD gas-credit billing).

---

## Headline verdicts

| # | Capability | Verdict | Exact API path | Design impact (1 line) |
|---|---|---|---|---|
| 1 | Server-context sign / sign-and-send a Solana tx (embedded/server wallet) | **supported** | `new PrivyClient({appId,appSecret}).wallets().solana().signAndSendTransaction(walletId, { transaction, caip2, ... })` (also `.signTransaction`) | Confirms §6.3; tx must be a **base64-serialized string** (not a web3.js object) and `caip2` is required; no SEND-only/broadcast-pre-signed method exists. |
| 2 | Caller-supplied idempotency key on the send call (anti double-send) | **supported** | `…solana().signAndSendTransaction(walletId, { transaction, idempotency_key, caip2, reference_id? })` | Confirms §6.3/§7; key must be **caller-deterministic + persisted before broadcast**; dedup window is **24h** (hard retry constraint). |
| 3 | Native Privy policy rules on a Solana USDC wallet: (1) per-tx cap (2) USDC mint (3) SPL program (4) recipient allowlist (5) rolling aggregate cap | **partial** | `client.policies.create({chain_type:'solana', rules:[…conditions]})` + `client.wallets.update(id,{policy_ids})` | Confirms 1–4; **BREAKS (5)** — rolling-window aggregate-spend cap is **absent** for Solana (empty `Aggregations` class + ETH-only method enum). |
| 4 | (a) Wallet owned by key-quorum threshold ≥2; (b) pending/Intents lifecycle to authorize out-of-band | **partial** | `client.keyQuorums.create({authorization_threshold:2,…})` → `client.wallets.create({owner_id})`; `client.intents.transfer(walletID, …)` + `.get/.list` | Confirms quorum + pending-intent create/poll; **BREAKS** the convenience assumption — there is **no `intents.authorize()`/`execute()` SDK method**; out-of-band approval is raw signature + HTTP the co-signer must implement. |
| 5 | Treasury wallet as **fee-payer** for a tx whose token authority is a **different** (user) wallet — deposit sponsorship | **unclear-from-types** (soft blocker) | `…solana().signTransaction(treasuryWalletId, {…})` / `signAndSendTransaction(…, { sponsor?:boolean })` | **Does NOT confirm §5.** `sponsor:true` is opaque USD gas-credit billing, not "treasury becomes on-chain fee-payer"; the salvage path (sign-only fee-payer slot) is unverified at runtime — **gating staging spike**. |
| 6 | SDK signs a **fully caller-constructed** Solana tx (server controls blockhash / durable nonce / exact bytes) | **supported** | `…solana().signTransaction(walletId, { transaction: string\|Uint8Array })` | Confirms §5 exact-message-equality and §6.4 controlled-lifetime; no blockhash/instruction param exists, so the caller owns 100% of message bytes (durable nonce is a caller convention). |
| 7 | Read Privy user + embedded Solana wallet; `verifyAccessToken → { user_id }` | **supported** | `privy.utils().auth().verifyAccessToken(token)` → `{ user_id }`; `privy.users()._get(did)` → `User.linked_accounts` | Confirms the deterministic embedded-Solana wallet picker; all 5 fields (`type/chain_type/connector_type/address/first_verified_at:number\|null`) match verbatim. |
| 8 | Which Solana + SPL libs our server must add (none installed) | **supported** (decision made) | `createSolanaKitSigner(client, {walletId,address,caip2?})` from `@privy-io/node/solana-kit` | Privy is on the **`@solana/kit` (web3.js v2)** stack — add `@solana/kit` + `@solana-program/token`; **do NOT** add web3.js v1 / `@solana/spl-token`; pin kit to one `^5.x`. |

---

## Per-capability findings

### 1. Sign / sign-and-send a Solana tx from server (app-secret) context — **supported**

**API surface.** All variants live on the high-level Solana service:
`const client = new PrivyClient({ appId, appSecret }); client.wallets().solana().<method>(walletId, input)`.
- **Sign-only:** `signTransaction(walletId: string, { transaction: string | Uint8Array, …auth }): Promise<SolanaSignTransactionRpcResponseData>` → `{ encoding:'base64', signed_transaction: string }`.
- **Combined (the §6.3-assumed call):** `signAndSendTransaction(walletId: string, { transaction: string | Uint8Array, caip2: string /* required */, address?, optimistic_broadcast?, reference_id?, sponsor?, …auth }): Promise<SolanaSignAndSendTransactionRpcResponseData>` → `{ caip2, hash: string, transaction_id?, signed_transaction?, reference_id? }`.
- **Sign-message** (bytes, not tx): `signMessage(walletId, { message: string | Uint8Array })`.
- **Low-level escape hatch:** `client.wallets().rpc(walletId, { method:'signAndSendTransaction', caip2, params:{ encoding:'base64', transaction } })`.

**Evidence.**
- `node_modules/@privy-io/node/public-api/services/solana.d.ts:4-10` — the three method signatures on `PrivySolanaService`.
- `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:1554-1577` — `SolanaSignAndSendTransactionRpcInput` (`caip2` required, `params:{encoding:'base64',transaction:string}`).
- `…/wallets.d.ts:1591-1600` — response: `hash:string`, `transaction_id?`, `signed_transaction?`, `reference_id?:string|null`.
- `…/wallets.d.ts:1641-1673` — `SolanaSignTransactionRpcInput` (no `caip2`) + `SolanaSignTransactionRpcResponseData{ signed_transaction }`.
- `node_modules/@privy-io/node/public-api/PrivyClient.d.ts:64-81` — constructor + `wallets()`.

**Static conclusion.** Confirmed. The spec-assumed `signAndSendTransaction` exists and returns a tx id/signature (`hash`). The tx is passed as a **base64-serialized string** (or `Uint8Array`, auto-encoded) — it does **NOT** accept a structured web3.js/kit `Transaction`; the caller must serialize first. `signAndSendTransaction` **requires** a `caip2` chain-id string (typed as bare `string`, no Solana-specific validation); `signTransaction` does not (offline sign). **No standalone SEND-only / broadcast-pre-signed method exists for Solana** — only sign-only and combined.

**Must verify in staging.** That the returned `hash` is the on-chain signature (vs `transaction_id` being a Privy-internal action id); that the hard-coded Solana-mainnet CAIP-2 string is accepted; base64 fidelity for both legacy and v0 (versioned) txs; the authorization_context/quorum flow end-to-end.

---

### 2. Caller-supplied idempotency key on sign-and-send — **supported**

**API surface.** Typed ergonomic field (recommended): `…solana().signAndSendTransaction(walletId, { transaction, idempotency_key, caip2, reference_id?, … })`. The input wraps `WithIdempotency<…>` which injects `IdempotencyConfig = { idempotency_key?: string }`, serialized by the SDK to the `privy-idempotency-key` HTTP header. Also available: raw header field `'privy-idempotency-key'?: string` on the low-level body, and per-request `RequestOptions.idempotencyKey?: string`.

**Evidence.**
- `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:3699-3745` — `reference_id?:string` on the send body **and** JSDoc on `'privy-idempotency-key'`: *"Idempotency keys ensure API requests are executed only once within a 24-hour window."*
- `node_modules/@privy-io/node/public-api/services/types.d.ts:22-37` — `IdempotencyConfig`/`WithIdempotency`.
- `node_modules/@privy-io/node/internal/request-options.d.ts:56-59` — `idempotencyKey?` escape hatch.
- `node_modules/@privy-io/node/CHANGELOG.md:693` — *"supports privy-idempotency-key (#10)"*. (README is a generic Stainless stub with no idempotency text.)

**Static conclusion.** Confirmed. A deterministic idempotency key is a **first-class typed param** on the exact Solana sign-and-send method, **plus** a separate `reference_id` client-reference field. Two critical caveats: (a) the SDK has a built-in `defaultIdempotencyKey()` per-call auto-generator, so for true exactly-once you **must supply your own deterministic key** (derived from ledger/round/transfer id, persisted **before** broadcast) — the auto-key would NOT dedup a retry from a fresh process after a crash; (b) dedup is documented as a **24-hour window**, so any retry path that can fire >24h later sits outside the guarantee.

**Must verify in staging.** Send the same key twice and confirm the second call does NOT re-broadcast; confirm the crash-after-broadcast/before-response replay returns the original signature; confirm `reference_id` is echo-only (not part of dedup); confirm the 24h window vs settler horizon.

---

### 3. Native Privy policy rules on a Solana USDC wallet (5 constraints) — **partial** (4 of 5; constraint 5 **absent**)

**API surface.** Policy CRUD from `PrivyClient`: `client.policies.create({ chain_type:'solana', name, version:'1.0', rules:[{ action:'ALLOW'|'DENY', method, name, conditions:[…] }], owner_id? })`; attach via `client.wallets.update(walletID, { policy_ids:string[] })`.

| Spec §9 constraint | Verdict | Condition |
|---|---|---|
| (1) per-tx amount cap | **YES (per-instruction)** | `SolanaTokenProgramInstructionCondition` `field:'TransferChecked.amount'` op `lte`/`lt` |
| (2) mint == USDC allowlist | **YES** | `field:'TransferChecked.mint'` op `eq`/`in` |
| (3) program == SPL allowlist | **YES** | `SolanaProgramInstructionCondition` `field:'programId'` op `eq`/`in` |
| (4) recipient allowlist | **YES** | `field:'TransferChecked.destination'` op `eq`/`in`/`in_condition_set` |
| (5) rolling-window aggregate-spend cap | **NO — ABSENT** | type machinery exists but unusable (see below) |

**Evidence.**
- `node_modules/@privy-io/node/resources/policies.d.ts:599-611` — `SolanaTokenProgramInstructionCondition` fields (`TransferChecked.amount/mint/destination/…`).
- `…/policies.d.ts:565-577` — `SolanaProgramInstructionCondition` (`programId`).
- `…/policies.d.ts:208-210` — `ConditionOperator` (`lte`/`in`/`in_condition_set`).
- `…/policies.d.ts:191-206` — `AggregationCondition` (`field_source:'reference'`, must start `aggregation.<id>`).
- `node_modules/@privy-io/node/resources/aggregations.d.ts:4-5` — **`export declare class Aggregations extends APIResource { }` — EMPTY** (no create/list/get/delete). Controller-verified.
- `…/aggregations.d.ts:103` — `AggregationMethod = 'eth_signTransaction' | 'eth_signUserOperation'` (**Ethereum-only**); `AggregationWindow{type:'rolling',seconds 1-72h}`; `AggregationMetric{function:'sum'}`. Controller-verified.
- `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:2773-2775` — `policy_ids: Array<string>` on the wallet.

**Static conclusion.** Constraints 1–4 are natively enforceable server-side by Privy and quorum-attachable — app code is not the enforcer. Caveat on (1): the amount cap is **per-instruction, not per-transaction total**; one tx can carry multiple transfer instructions, so the cap must be paired with structural rules (force `TransferChecked`, constrain instruction count / forbid unknown programs) to be a true per-tx ceiling, and non-`TransferChecked` transfers (no mint field) should be globally DENIED. **Constraint 5 is absent**: the rolling-sum primitive exists only as Ethereum-scoped types behind an **empty `Aggregations` resource class** (no create method in `.d.ts` or runtime `.js`/`.ts`), and `AggregationMethod` admits no Solana method — so "max $X per 24h across all txs" **cannot** be a Privy-enforced rule for this Solana wallet.

**Must verify in staging.** Whether a single policy correctly evaluates **every** transfer instruction in a multi-instruction tx (anti-batching); whether the raw REST `POST /v1/aggregations` exists at all / accepts Solana (confirm empty SDK class is a typegen lag vs. a true product gap); whether `in_condition_set` works end-to-end on Solana token-program fields.

---

### 4. (a) Quorum-owned wallet threshold ≥2; (b) pending/Intents authorize-later — **partial**

**API surface.**
- **Create quorum (≥2):** `client.keyQuorums.create({ authorization_threshold: 2, public_keys?, user_ids?, key_quorum_ids? })` → `KeyQuorum.id`.
- **Assign quorum as owner:** `client.wallets.create({ chain_type, owner_id: quorumId })` (threshold lives on the **quorum**, not the wallet).
- **Create pending transfer intent:** `client.intents.transfer(walletID, { destination, source, amount_type?, … })` → `TransferIntentResponse` (`status` can be `'pending'`; `authorization_details[].{threshold, members[].signed_at}`; `expires_at`).
- **Poll:** `client.intents.get(intentID)`, `client.intents.list({ status?, … })`.
- **ABSENT:** `client.intents.authorize(…)` and any intent `execute()` **do not exist**. `IntentAuthorizeInput { signature, timestamp }` is an exported type **consumed by no SDK method**. Controller-verified.

**Evidence.**
- `node_modules/@privy-io/node/resources/key-quorums.d.ts:24,108-133` — `create(...)`, `authorization_threshold?:number` ("≤ total members").
- `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:3164,3188-3192` — `owner_id?` ("key quorum ID to set as owner").
- `…/wallets.d.ts:2769-2771` — wallet response has `owner_id` but **no threshold field**.
- `node_modules/@privy-io/node/resources/intents.d.ts:91-110` — `transfer(...)` ("must be authorized by either the wallet owner or signers before it can be executed").
- `…/intents.d.ts:13-167` — full `Intents` class method list: `list/get/transfer/createPolicyRule/...` — **no `authorize()`, no `execute()`**. Controller-verified.
- `…/intents.d.ts:330` — `IntentAuthorizeInput { signature, timestamp }` (type only, unused).
- `node_modules/@privy-io/node/public-api/services/intents.d.ts:6-16` — `PrivyIntentsService` exposes no `authorize()`.
- `node_modules/@privy-io/node/lib/authorization.d.ts:11-35,99-106` — `AuthorizationContext` + `prepareRequest` (the out-of-band signing path, via `privy-authorization-signature` header).
- `node_modules/@privy-io/node/resources/webhooks.d.ts` — `IntentAuthorizedWebhookPayload` (`type:'intent.authorized'`).

**Static conclusion.** Both halves are partially confirmed. **(a)** A wallet CAN be owned by a key-quorum with `authorization_threshold >= 2`, but it is a **two-step** create (quorum first, then `wallets.create({owner_id})`); the threshold is a property of the quorum, so the design's "threshold ≥2" check must read `KeyQuorum.authorization_threshold`, not any wallet field. **(b)** Creating an under-signed `intents.transfer` is the documented pending-pattern: the intent persists as `status:'pending'` with `intent_id`, and `authorization_details` exposes the unmet threshold and each member's `signed_at`. **BREAKING gap:** there is **no native SDK `authorize()`/`execute()` call**. The spec line "a separate signing service authorizes later" cannot bind to a typed Privy method — the independent co-signer must **generate a request signature (P-256, via `lib/authorization.ts`) and POST it to the intent's authorize route itself** (route shape unverified from types; `IntentAuthorizeInput{signature,timestamp}` is the body but no client method wraps it). Completion is observable via the `intent.authorized` webhook.

**Must verify in staging.** The actual HTTP route a second approver hits to add a signature; that an under-signed `intents.transfer` yields `status:'pending'` (not an immediate 400); whether the intent auto-executes once threshold is met; quorum membership semantics (P-256 `public_keys` vs `user_ids`); the intent expiry window (default 72h per `PrivyClientOptions.requestExpiry.defaultIntentMs`); webhook reliability as the state-machine trigger.

---

### 5. Treasury as fee-payer for a different wallet's authority (deposit sponsorship) — **unclear-from-types** (soft blocker)

**API surface.** Public paths: `…solana().signAndSendTransaction(walletId, { transaction, caip2, sponsor?:boolean, … })` and `…solana().signTransaction(walletId, { transaction, … })` (no `sponsor` field). **No method takes a `feePayer`/`fee_payer` wallet param, and no method designates one wallet as fee-payer for another wallet's authority.** The only explicit fee-payer construct in the SDK is `TempoFeePayerSignature` (secp256k1/EVM-Tempo — inapplicable to Solana ed25519).

**Evidence.**
- `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:1554-1577` — `sponsor?:boolean` is a bare toggle; no field names a different fee-payer wallet. Controller-verified (`sponsor?:boolean` at multiple lines incl. 1568).
- `…/wallets.d.ts:1641-1674` — sign-only path: no `sponsor`, no fee-payer-role param.
- `node_modules/@privy-io/node/resources/wallet-actions.d.ts:575-578` — `gas_credits_charged_usd?` confirms `sponsor` = **Privy-managed USD gas-credit billing**, not "your treasury becomes the on-chain fee-payer". Controller-verified.
- `node_modules/@privy-io/node/resources/transactions.d.ts:31` — resulting tx only records `sponsored?:boolean`, exposes no fee-payer pubkey.
- `…/wallets.d.ts:2176` — `TempoFeePayerSignature` (secp256k1 only).
- `node_modules/@privy-io/node/resources/funding.d.ts:3-4` — `Funding` resource is **empty** (fiat on-ramp types only; no on-chain fee-payer/deposit method).

**Static conclusion.** The SDK has **no first-class API** for the spec's exact construct (treasury = fee-payer / `accountKeys[0]` for a tx whose token authority is a different user wallet). `sponsor:true` is opaque Privy-managed gas-credit sponsorship billed in USD — the types do **not** show it placing the treasury as on-chain fee-payer. The only plausible salvage is the **sign-only `signTransaction` path**: the caller builds the tx with treasury=fee-payer + user=authority, gathers both signatures (treasury via `signTransaction`, user via their wallet), and submits to an RPC itself — but this hinges on Privy actually signing a tx where the wallet is **merely the fee-payer** (slot-level signing intent is not expressible in `.d.ts`) AND the wallet policy allowing it. Verdict is **unclear-from-types** — a happy-path TS compile would NOT prove the on-chain semantics; this is a money-moving gate, so it is a **soft blocker** until staging resolves it.

**Must verify in staging.** (gating, see checklist) Build treasury-fee-payer + different-user-authority tx, call `signTransaction(treasuryWalletId, …)`, confirm Privy fills only the fee-payer slot and the policy permits it; confirm self-submit lands on-chain; inspect whether `sponsor:true` changes the on-chain fee-payer at all; confirm gas-credit sponsorship is funded/enabled for mainnet Solana.

---

### 6. SDK signs a fully caller-constructed tx (server controls blockhash / nonce / bytes) — **supported**

**API surface.** Both `…solana().signTransaction(walletId, { transaction: string | Uint8Array, …auth })` and `…solana().signAndSendTransaction(walletId, { transaction, caip2, … })` accept exactly `{ encoding:'base64', transaction:string }` — a complete, serialized Solana message the caller builds. Helper: `createSolanaKitSigner(client, {walletId,address,caip2?})`.

**Evidence.**
- `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:1654-1657` — `SolanaSignTransactionRpcInputParams{ encoding:'base64', transaction:string }`.
- `…/wallets.d.ts:1574-1577` — same for sign-and-send.
- `…/wallets.d.ts:1671-1674` — `signed_transaction:string` response.
- `node_modules/@privy-io/node/public-api/services/solana.d.ts:7-9,30-32` — service signatures; input accepts `string | Uint8Array`.

**Static conclusion.** Confirmed. There is **no** `blockhash`/`recentBlockhash`/`durable-nonce`/`lifetime`/instruction-list parameter anywhere in the Solana signing types (exhaustive grep finds those tokens only in unrelated OAuth/TTL fields). Privy does **not** assemble the message or fetch a blockhash for these methods — the caller controls 100% of the message bytes, including the lifetime constraint (recent blockhash OR an `AdvanceNonceAccount` durable-nonce instruction). The SDK only wraps the bytes with auth/idempotency/expiry headers plus `address`/`wallet_id`/`chain_type` (and for sign-and-send `caip2`/`sponsor`/`optimistic_broadcast`) — none mutate the message. Durable nonce is a **caller convention** (put `AdvanceNonceAccount` as instruction[0]), not an SDK feature.

**Must verify in staging.** That Privy signs the **exact bytes** submitted (`sha256(submitted) == sha256(message in returned signed_transaction)` — byte fidelity is not type-enforced); that `signTransaction` does NOT silently broadcast; that a durable-nonce tx is accepted unchanged; whether the policy engine rewrites bytes before signing; whether `sponsor`/`optimistic_broadcast` on `signAndSendTransaction` refreshes/overrides the blockhash (if §5 needs exact-bytes-equality, prefer `signTransaction` + self-broadcast).

---

### 7. Read user + embedded Solana wallet; `verifyAccessToken → { user_id }` — **supported**

**API surface.** Token: `privy.utils().auth().verifyAccessToken(accessToken: string): Promise<VerifyAccessTokenResponse>` with `.user_id: string`. User: `privy.users()._get(userID: string): APIPromise<User>`; `User.linked_accounts: Array<LinkedAccount>`; the embedded-Solana member is `LinkedAccountSolanaEmbeddedWallet`. `InvalidAuthTokenError` is a named export.

**Evidence.**
- `node_modules/@privy-io/node/public-api/services/utils/auth.d.ts:15` — `verifyAccessToken(...)`.
- `node_modules/@privy-io/node/lib/auth.d.ts:33-46` — `VerifyAccessTokenResponse.user_id: string`.
- `node_modules/@privy-io/node/resources/users.d.ts:57` — `_get(userID): APIPromise<User>` (the `_get` underscore is correct; Stainless reserves bare `get`).
- `…/users.d.ts:992` — `linked_accounts: Array<LinkedAccount>`.
- `…/users.d.ts:788-808` — `LinkedAccountSolanaEmbeddedWallet { type:'wallet'; chain_type:'solana'; connector_type:'embedded'; address:string; first_verified_at:number|null; … }`.
- `…/users.d.ts:286` — `LinkedAccount` discriminated union includes that member.
- `node_modules/@privy-io/node/index.d.ts:12` — `InvalidAuthTokenError` exported.

**Static conclusion.** Confirmed — no design-breaking gap. Every field the picker keys on exists with the **exact** snake_case name, casing, and nullability: `type:'wallet'`, `chain_type:'solana'`, `connector_type:'embedded'`, `address`, and `first_verified_at: number | null`. The picker's `first_verified_at ?? Number.MAX_SAFE_INTEGER` null-coalesce + earliest-verified-wins tiebreak is sound because the field is genuinely `number | null`. The specific risk this lane guarded against — `first_verified_at` missing/renamed — does **not** occur. **Analysis note (not type-breaking):** `privy-wallet.ts` re-declares its own all-optional `LinkedAccount` and casts `as any` at the adapter boundary, so TypeScript will NOT catch a future Privy field rename — the staging wire-value checks are the only guard against silently-wrong payout-identity selection.

**Must verify in staging.** Real JSON `connector_type` literal is `'embedded'`; `first_verified_at` is populated (non-null; ms vs s) on real records; a freshly-created (unverified) embedded wallet still appears in `linked_accounts`; `verifyAccessToken().user_id` equals the DID format `users._get(did)` accepts.

---

### 8. Solana + SPL libraries our server must add — **supported** (decision made)

**API surface.** Privy interop entry: `createSolanaKitSigner(client: PrivyClient, { walletId, address: Address, authorizationContext?, caip2? }): SolanaKitSigner`, imported from `'@privy-io/node/solana-kit'`. `SolanaKitSigner = MessagePartialSigner & TransactionPartialSigner & TransactionSendingSigner & Readonly<{ walletId, address }>`. `Address` comes from `'@solana/kit'`; the signer interfaces from `'@solana/signers'`.

**Evidence.**
- `node_modules/@privy-io/node/solana-kit.d.ts:1-2` — `import { type Address } from '@solana/kit'` + signer trio from `'@solana/signers'`.
- `node_modules/@privy-io/node/solana-kit.d.ts:25-28,52` — `SolanaKitSigner` type + `createSolanaKitSigner(...)`.
- `node_modules/@privy-io/node/package.json` — `peerDependencies: { "@solana/kit": "^5.1.0" }`, `peerDependenciesMeta.@solana/kit.optional: true`.
- `node_modules/@privy-io/node/CHANGELOG.md:437,455` — "introduces the @solana/kit signer (#78) … moves to @solana/kit (#77)".
- `server/package.json:21` — only `@privy-io/node`; **no** `@solana/kit`, `@solana-program/token`, `@solana/web3.js`, or `@solana/spl-token` present.

**Static conclusion.** Privy `@privy-io/node@0.22.0` is unambiguously on the **`@solana/kit` (web3.js v2)** stack (v1 has no `MessagePartialSigner`/`TransactionPartialSigner`/`TransactionSendingSigner`). Privy's surface only **signs/sends a pre-built tx** — it does NOT build `transferChecked`, fetch a mint, or parse token balances; those are entirely ours and need their own libs. Because the peer is **optional**, nothing pulls kit in transitively — installing it is mandatory and on us. See the library-decision section for the exact package list and the version-pin risk.

**Must verify in staging.** Pin `@solana/kit` to a single `^5.x` shared by both `@privy-io/node` and `@solana-program/token` (the latest published kit is 6.x; two copies make the branded `Address`/`Transaction` types structurally incompatible at the `createSolanaKitSigner` boundary); confirm `@solana-program/token`'s kit range overlaps; confirm the wire format Privy expects for `transaction`; confirm `fetchMint` returns decimals + owner program (Tokenkeg vs Token-2022); validate `getTransaction` returns `uiTokenAmount.amount` as base-unit strings.

---

## Design-breaking gaps (BLOCKERS)

Two confirmed ABSENT capabilities and one soft (money-moving, unclear-from-types) blocker. These are stated without softening. **All three were spot-verified by the controller against the installed types.**

1. **HARD — Rolling-window aggregate-spend cap (spec §9 constraint 5) is ABSENT for Solana.** There is no usable native Privy rolling-window velocity cap in `@privy-io/node@0.22.0`. The `Aggregations` resource class is an **empty shell** (`resources/aggregations.d.ts:4-5`, no create/list/get/delete in `.d.ts` or runtime `.js`/`.ts`), and the rolling-sum primitive is **Ethereum-scoped by schema** (`AggregationMethod = 'eth_signTransaction' | 'eth_signUserOperation'`, `aggregations.d.ts:103`). "Max $X spent per 24h across all txs" **cannot** be expressed as a Privy-enforced rule for a Solana USDC wallet. → The §9 "native aggregate cap" line is **unmet**; the velocity/aggregate ceiling **must** be enforced in an independent co-signer/quorum member (your own server tracking cumulative spend, refusing to co-sign past the window). Do not budget real money on the assumption Privy enforces it.

2. **HARD — No native `intents.authorize()` / `intents.execute()` SDK method (spec §6.3/§9 out-of-band approval).** The Intents lifecycle supports **create + poll** (`intents.transfer`, `.get`, `.list`) and persists under-signed transfers as `status:'pending'` with the unmet threshold visible — but the SDK exposes **no typed method** to add a signature to a pending intent. `IntentAuthorizeInput{signature,timestamp}` is an exported type consumed by nothing (`intents.d.ts:13-167,330`; `public-api/services/intents.d.ts:6-16`). → The "separate signing service authorizes later" step is **on us**: the independent co-signer must generate a P-256 request signature (`lib/authorization.ts`) and POST it to the intent's authorize route itself. The route shape is unverified from types and must be confirmed in staging. This does not block the custody model (quorum-owned wallet + pending intent are real) but does block any assumption that a one-call SDK authorize exists.

3. **SOFT (money-moving, unclear-from-types) — Treasury-as-fee-payer deposit sponsorship (spec §5/§14) is NOT confirmed.** No SDK param designates the treasury wallet as on-chain fee-payer for a tx whose authority is the user's wallet. `sponsor:true` is opaque USD gas-credit billing, not that mechanism (`wallets.d.ts:1568`, `wallet-actions.d.ts:575-578`). The only salvage path (`signTransaction` sign-only to fill a fee-payer slot) depends on runtime policy-engine behavior the types cannot express. → Per the conservative rule, an unclear-from-types verdict on a money-moving capability is a **soft blocker that staging must resolve, not a confirmed pass.** Do NOT mark §5 "supported". If Privy's policy engine refuses to sign fee-payer-only txs, the §5/§14 deposit-sponsorship design is broken and must fall back to (a) user pays own gas, (b) user pre-funds tiny SOL, or (c) Privy gas-credit sponsorship with whatever fee-payer Privy chooses.

**Everything else is statically confirmed:** server-context sign/sign-and-send (1), idempotency key (2), policy constraints 1–4 (3), quorum ≥2 + pending-intent create/poll (4a/4b), exact-byte caller-constructed signing (6), user/wallet read + token verify (7), and the kit-aligned library stack (8).

---

## Solana library decision

Privy `@privy-io/node@0.22.0` is on the **`@solana/kit` (web3.js v2)** stack, so our server must adopt the **same family** to interop without a lossy `PublicKey`↔`Address` bridge at every Privy call. `server/package.json` currently has only `@privy-io/node` — all Solana libs must be added by us (the kit peer is optional and pulled in by nothing transitively).

**Add to `server/package.json`:**
- **`@solana/kit`** — the v2 client. Provides `Address`, `createSolanaRpc`/`createSolanaRpcSubscriptions`, tx-message builders (`createTransactionMessage`, `appendTransactionMessageInstruction`, `setTransactionMessageFeePayerSigner`, `setTransactionMessageLifetimeUsingBlockhash`), `compileTransaction` + `getBase64EncodedWireTransaction` (produces the base64 `transaction` string Privy's `signAndSendTransaction` wants), and `getTransaction` (reads `meta.pre/postTokenBalances`). Re-exports `@solana/signers` so `SolanaKitSigner` drops in as the fee-payer signer.
- **`@solana-program/token`** — the generated SPL Token client. `fetchMint` (the `getMint` equivalent: decimals + authority; pair with the account owner to assert the token program) and `getTransferCheckedInstruction` (builds `transferChecked` with mint + decimals enforced). Covers §5's `transferChecked` + `getMint`.
- **`@solana-program/token-2022`** — only if Token-2022 mints must be supported.
- **`@solana-program/system`** — only if the server creates ATAs.

**Do NOT add** `@solana/web3.js` (v1) or `@solana/spl-token` (v1) — wrong stack, incompatible branded `Address` type.

**The one real risk — version pin.** Privy's peerDependency is `@solana/kit: ^5.1.0`, but the latest published `@solana/kit` is `6.x`. **Pin kit to a single `^5.x` line shared by BOTH `@privy-io/node` and `@solana-program/token`** (use npm `overrides`/`dedupe` to guarantee exactly one copy), or the branded `Address`/`Transaction` types from two kit instances won't unify at the `createSolanaKitSigner` boundary — TS rejects the signer or runtime mis-tags accounts. Bump to 6.x only after confirming `@solana-program/token`'s kit range and Privy still type-check together.

---

## Remaining staging checklist (needs live Privy app + credentials — the part that gates Plan 3)

Each item is a concrete pass/fail assertion. **Item 1 is GATING for both Plan 2 (deposit) and Plan 3 (withdraw)** per §5; items 2–6 gate Plan 3; items 7–10 gate the §9 policy/quorum design; items 11–12 are install/identity correctness. Run roughly in this order.

1. **[GATES PLAN 2 + PLAN 3 — deposit fee-payer sponsorship]** Build a Solana tx where treasury = fee-payer (`accountKeys[0]`) and a **different** user wallet = SPL token-transfer authority. Call `…solana().signTransaction(treasuryWalletId, { transaction, caip2 })`. **PASS** iff Privy returns a `signed_transaction` filling **only** the fee-payer signature slot and does NOT reject because the treasury is not the authority; **and** the treasury's wallet policy permits signing a tx where it is fee-payer but NOT the instruction authority (no SOL/token leaves the treasury except gas lamports). Separately, call `signAndSendTransaction` with `sponsor:true` and inspect the on-chain tx to determine whether `accountKeys[0]` is the treasury or a Privy-managed sponsor. **FAIL on either** → §5 deposit-sponsorship is broken; fall back to user-pays-gas / pre-fund / Privy-chosen sponsor.
2. **[idempotency dedup]** Send the **same** `idempotency_key` twice (first succeeds). **PASS** iff the second call returns the original result and does **not** broadcast a second Solana tx.
3. **[crash-after-broadcast]** Drop the connection after broadcast but before the HTTP response; replay with the same key. **PASS** iff the replay returns the already-broadcast signature (no second send). Confirm the 24h dedup window covers the settler retry horizon and that `reference_id` is echo-only (not part of dedup).
4. **[hash semantics]** Confirm `signAndSendTransaction`'s returned `hash` is the on-chain signature usable for confirmation polling, and whether `transaction_id` is a Privy-internal action id. **PASS** iff `hash` confirms on-chain.
5. **[byte fidelity]** Confirm `sha256(submitted message) == sha256(message inside returned signed_transaction)` for `signTransaction`, for both legacy and v0 txs, and that a durable-nonce tx (`AdvanceNonceAccount` as instruction[0]) is signed unchanged. **PASS** iff bytes are identical and `signTransaction` does **not** silently broadcast.
6. **[CAIP-2]** Confirm the Solana-mainnet CAIP-2 string (`solana:<genesis-hash>`) is accepted by the live `signAndSendTransaction` endpoint (typed only as bare `string`). **PASS** iff accepted; record the exact value.
7. **[quorum ≥2 owns wallet]** `keyQuorums.create({authorization_threshold:2,…})` then `wallets.create({owner_id})`. **PASS** iff the wallet's owning quorum reports `authorization_threshold:2`.
8. **[pending intent persists]** Create `intents.transfer` against the quorum-owned wallet with insufficient/zero signatures. **PASS** iff it returns `status:'pending'` with `intent_id` and `authorization_details` showing the unmet threshold (not an immediate 400).
9. **[out-of-band authorize route]** Determine the actual HTTP route a second approver POSTs a `{signature,timestamp}` to (no SDK method wraps it), and confirm two P-256 signatures satisfy a threshold-2 quorum and the intent then executes (auto vs explicit trigger) and surfaces a `transaction_id`. Confirm the `intent.authorized`/`intent.executed` webhooks fire as the state-machine trigger. **PASS** iff a second signature drives the pending intent to executed and the route/membership semantics are documented.
10. **[policy enforcement on Solana]** Attach a policy and confirm: a multi-instruction tx is evaluated **per instruction** so the per-instruction amount cap cannot be bypassed by batching; non-`TransferChecked` (no-mint) transfers are DENIED; `in_condition_set` works on Solana token-program fields. **PASS** iff batched-spend-over-cap is rejected and mint/recipient allowlists hold. **Separately confirm constraint 5 is truly absent** by probing raw `POST /v1/aggregations` with a Solana method (distinguishes typegen lag from product gap) — assume absent until proven otherwise; the rolling aggregate cap lives in our co-signer regardless.
11. **[lib install]** `npm install` with `@solana/kit` pinned to one `^5.x` shared by Privy + `@solana-program/token`; confirm `npm ls @solana/kit` shows exactly one copy and `createSolanaKitSigner` + `getTransferCheckedInstruction` + `fetchMint` type-check against the same `Address` brand. Send one real devnet `transferChecked` through `signAndSendTransaction` and confirm it lands. **PASS** iff single kit copy, types unify, devnet tx confirms.
12. **[identity wire values]** Against a live Privy response, confirm an embedded Solana wallet serializes `connector_type:'embedded'`, has a non-null `first_verified_at` (ms vs s), appears in `linked_accounts` even when freshly created/unverified, and that `verifyAccessToken().user_id` equals the DID accepted by `users._get(did)`. **PASS** iff the picker selects the correct payout wallet on real data.

---

## Recommendation

**Proceed now (statically confirmed, no live Privy app required):**
- Adopt the **`@solana/kit` library stack** — add `@solana/kit` + `@solana-program/token` to `server/package.json`, pin kit to one `^5.x`, wire `createSolanaKitSigner`. This unblocks all tx-construction/serialization scaffolding (capability 8).
- Build the **USDC base-unit scale module** (`BASE_UNITS_PER_CENT = 10_000n`; pure; throws on dust) and the **deterministic idempotency-key derivation util** (`'withdraw:'||id`) — both pure, fully TDD-able, never wasted regardless of how the fee-payer test resolves (capabilities 2).
- Build the **exact-message-equality + controlled-lifetime** model (server authors full message, durable nonce as instruction[0]) — sound against the types (capability 6).
- Build the **deterministic embedded-Solana wallet picker** and token-verify middleware — fields match verbatim (capability 7, already shipped in Plan 1). Add the staging wire-value checks because the adapter casts `as any` and opts out of the compile-time net.
- Design the **native Privy policy rules for §9 constraints 1–4** and the **quorum-owned (threshold ≥2)** treasury wallet + **pending-intent create/poll** flow (capabilities 3, 4).

**Hard-blocked on staging — do NOT finalize the plan until resolved:**
- **Plan 2 (deposit) is gated on staging item 1** (treasury-as-fee-payer). Unclear-from-types and money-moving — run item 1 first; if it fails, the deposit-sponsorship design must change before Plan 2 is written.
- **Plan 3 (withdraw) is gated on** the out-of-band intent-authorize route (item 9 — no SDK method exists) and the idempotency/byte-fidelity tests (items 2–6).
- **Build the rolling-window aggregate-spend cap (§9 constraint 5) in our own co-signer/quorum member — not in Privy.** Confirmed absent in the SDK; do not wait on staging to "find" it.

**Net:** the custody core (quorum-owned wallet, deterministic signing, idempotent sends, per-tx/mint/program/recipient policies, kit-aligned libs, user/wallet identity) is statically sound and safe to scaffold now. Two capabilities the spec leaned on are **absent** (native aggregate-spend cap; one-call intent authorize) and **must be implemented in our own server-side co-signer**; one money-moving capability (treasury fee-payer sponsorship) is **unverified and gating** — the single most important staging test, blocking both deposit and withdraw plans. No real money moves until staging items 1–9 pass on a live Privy app.
