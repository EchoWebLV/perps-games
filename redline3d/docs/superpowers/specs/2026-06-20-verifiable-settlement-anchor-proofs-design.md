# Verifiable Settlement (Anchor Proofs) — Design

**Status:** approved design, ready for implementation plan.
**Builds on:** Pillar 1.2 server-side authoritative settlement (`2026-06-20-backend-1.2-server-side-settlement.md`). Additive — the off-chain settlement engine is unchanged.

## Overview

Make every settled round **independently verifiable by anyone**, and **anchor a Merkle root of settled rounds on Solana** so settlement history cannot be rewritten. This converts the synthetic house-vault's trust model from *"trust the house"* to *"verify the house."*

This is the cheapest, sharpest differentiator against the market leader. A verified competitor teardown (2026-06-15, re-confirmed 2026-06-20, HIGH confidence) found **Banana Zone** — a synthetic house-vault fixed-odds binary (5s rounds, hardcoded `[6…1.8…6]` odds ladder, server-set prices, MagicBlock ephemeral-rollup custody) — ships **zero** published fairness: no provably-fair, no commit-reveal, no published odds, no "verify this round" tool, no public attestation. Its entire trust mechanism is *"the backend said so."* Anchor proofs put Perps Rider on an axis the market leader has abandoned.

### What this defeats (threat model)

The core attack on a price-settled house game: the operator picks **which price / which timestamp** to settle against *after* seeing the bet, or **retroactively edits** a settled round. Anchor proofs make both impossible:

1. **Price provenance** — entry/exit/action prices are bound to Pyth's *guardian-signed* updates at pinned `publish_time`s, so the house cannot invent or cherry-pick a price.
2. **Deterministic public recompute** — `settleRound` is open-source and pure, so anyone re-runs the anchored inputs and gets the identical payout.
3. **Tamper-evident history** — a periodic Merkle root posted to Solana proves no settled round was altered after the fact.

### Non-goals (explicit — do not oversell)

- **Not solvency.** Proving a payout was computed correctly says nothing about whether the vault can *pay* it. Proof-of-reserves is a separate track.
- **Not engine-execution integrity.** Anchor proofs prove the *inputs* (signed prices) and that *records weren't altered*. They do **not** prove the off-chain engine ran the committed formula on every round in real time (a malicious operator could drop/reorder rounds before anchoring). Only an on-chain ER or zk closes that gap — deferred, build only if a counterparty demands it.
- **Not meta-fairness.** Says nothing about which rounds/odds/leverage are offered, or that the house edge is "fair." It makes a *rigged-after-the-fact* game impossible, nothing more.
- **Not regulatory cover.** Verifiability ≠ legal compliance. The jurisdiction/legal read remains the real gate.

## Architecture

Two stages, one plan, sequenced:

- **Stage A — Provenance + recompute (off-chain proof artifacts).** Capture the signed Pyth update for every stamped price; store a deterministic per-round `leafHash`; expose a public `GET /v1/round/:id/proof`; ship a `verifyRoundProof` function. This alone kills price cherry-picking and enables "verify my round."
- **Stage B — Solana anchor (the on-chain part).** A single-instance worker batches settled-round leaves into a Merkle tree and posts the 32-byte root to Solana via an SPL Memo (a devnet relayer keypair). Each round stores its Merkle proof + the anchor tx; the verifier folds the leaf to the on-chain root.

```
open  ── stamp+store entry signed update ──┐
action ─ stamp+store action signed update ─┤
close ── stamp exit, settle, compute leafHash, store ─┘
                         │
            (Stage B) anchor worker: batch settled leaves → Merkle root
                         │
                Solana SPL Memo(root)  [devnet]
                         │
GET /v1/round/:id/proof ── anyone: verify Pyth sigs + recompute + Merkle path + on-chain root
```

## Decisions (baked in)

- **Signed updates stored OFF-CHAIN, verified against Pyth's guardian set by anyone** — not posting `PriceUpdateV2` on-chain (pure cost, no added trust for our use case).
- **Batched Merkle root via SPL Memo**, not per-round (per-round is wasteful + TPS-bound; batched ≈ $0/round, the memo needs no rent).
- **Devnet first**, mainnet behind a config flip (`ANCHOR_NETWORK`), same "flip real things last" discipline as the money switch.
- **Single-instance** anchoring worker (may later share a process with the deferred autonomous settler).
- **Shared, open-source leaf canonicalization + Merkle + decode in `@perps/engine`**, so the server and any third-party verifier compute identical results.
- **Capture-at-stamp, never refetch.** The signed update is stored at the moment the price is stamped; the verifier reads stored artifacts (avoids any Hermes historical-retention dependency).

## Components

### 1. Signed-price capture (feed layer)

Hermes `GET /v2/updates/price/latest?ids[]=…&parsed=true&encoding=hex` returns a guardian-**signed** `binary.data[0]` accumulator update (covering all requested feeds at one `publish_time`) alongside the decoded `parsed[]` prices. We currently keep only the decoded price; we start keeping the signed blob too.

```ts
// @perps/engine (or server/src/feed/types.ts) — extend the tick
interface SignedPriceUpdate {
  feedId: string;      // Pyth feed id (hex) of the asset
  binary: string;      // hex of binary.data[0] — the guardian-signed accumulator update
  publishTime: number; // seconds
  price: string;       // raw integer price string (from parsed) — verifier decodes this
  conf: string;
  expo: number;
}
interface PriceTick { price: number; tsUs: number; signed?: SignedPriceUpdate }
```

- **Hermes feed:** `tickOnce()` captures `binary.data[0]` + per-asset parsed fields, attaches a `SignedPriceUpdate` to each asset's tick. (The same binary blob is referenced by every asset stamped from that poll — store per stamp; a content-hash dedup is a later optimization.)
- **Stub feed (tests):** emits a deterministic synthetic `SignedPriceUpdate` (e.g. `binary: "00".repeat(...)`, fixed feedId) so proof-bundle assembly + Merkle logic are testable without network or real signatures.
- `signed` is optional so existing 1.2 code paths keep compiling; settlement still uses the decoded `price`/`tsUs`. Provenance reads `signed`.

### 2. Round proof record (data model)

Store one signed update per stamped price + a per-round leaf + the anchor result.

```ts
// new table: round_price_proofs (append-only, one row per stamped price)
round_price_proofs {
  id uuid pk
  roundId uuid → rounds.id
  role text          // "entry" | "exit" | "action"
  seq integer        // 0 for entry/exit; action seq for actions
  feedId text
  binary text        // hex signed update
  publishTime bigint // seconds
  rawPrice text      // integer price string
  expo integer
  createdAt timestamptz
  UNIQUE(roundId, role, seq)
}

// columns added to rounds:
leafHash text            // hex sha256 leaf, set at settle (null while open)

// new table: round_anchors (filled by the anchor worker, one row per anchored round)
round_anchors {
  roundId uuid pk → rounds.id
  merkleRoot text     // hex 32-byte root
  merkleProof jsonb   // [{ hash, position: "L"|"R" }, ...]
  batchId text
  anchorTx text       // Solana tx signature
  network text        // "devnet" | "mainnet-beta"
  anchoredAt timestamptz
}
```

(Storing `binary` in Postgres `text` is fine — a Pyth accumulator update is a few KB.)

### 3. Shared leaf canonicalization (`@perps/engine`)

Pure, deterministic, open-source so server and verifier agree byte-for-byte.

```ts
interface RoundLeafData {
  roundId: string;
  asset: string;
  openDir: 1 | -1;
  openLev: number;
  stake: number;
  cfg: RoundConfig;
  entry: PriceCommitment;
  actions: ActionCommitment[];   // ordered by seq
  exit: PriceCommitment;
  result: { outcome: SettleReason; equity: number; payoutCoins: number; pnlCoins: number };
}
interface PriceCommitment { rawPrice: string; expo: number; publishTime: number; updateHash: string } // updateHash = sha256(binary)
interface ActionCommitment extends PriceCommitment { kind: "flip" | "lever" | "bonus"; dir?: 1 | -1; lev?: number }

function roundLeaf(d: RoundLeafData): string; // sha256 hex over canonical JSON (sorted keys, fixed formatting)
function decodePythPrice(rawPrice: string, expo: number): number; // parseFloat(rawPrice) * 10**expo — the SAME decode the server settled with
```

- The leaf binds to the **raw** Pyth integer price + expo + publishTime + `updateHash` (= sha256 of the signed blob), not the lossy decoded float — the verifier re-derives the decoded price via `decodePythPrice` and feeds it to `settleRound`.
- `updateHash` ties the leaf to the exact signed blob without bloating the leaf with the full update.

### 4. Merkle batch + Solana anchor worker (Stage B)

```ts
// @perps/engine — merkle helpers (shared with the verifier)
function merkleRoot(leaves: string[]): string;                    // sha256(left||right), odd node duplicated (documented)
function merkleProof(leaves: string[], index: number): MerkleStep[];
function verifyMerkle(leaf: string, proof: MerkleStep[], root: string): boolean;
interface MerkleStep { hash: string; position: "L" | "R" }

// server/src/anchor — the sink seam (testable, swappable)
interface AnchorSink {
  anchor(root: Uint8Array, meta: { batchId: string; count: number }): Promise<{ txSig: string }>;
}
// solanaMemoSink(connection, relayerKeypair): posts a single SPL Memo instruction:
//   data = `PRV1:${base64(root)}:${batchId}:${count}`
// fakeSink (tests): records the root, returns a deterministic fake txSig
```

**Worker loop** (single instance; runs only if `ANCHOR_NETWORK !== "off"` and a relayer secret is present):
1. `SELECT … FROM rounds WHERE leafHash IS NOT NULL AND id NOT IN (SELECT roundId FROM round_anchors) ORDER BY settledAt LIMIT ANCHOR_BATCH_MAX`.
2. Build the Merkle tree over the batch's `leafHash`es.
3. `sink.anchor(root, …)` → `txSig`.
4. After the tx confirms, insert a `round_anchors` row per round (`merkleRoot`, `merkleProof`, `batchId`, `anchorTx`, `network`, `anchoredAt`).
- **Idempotent:** a round with a `round_anchors` row is skipped; re-running mid-batch can only re-anchor un-anchored rounds.
- **Single-writer:** a process-level singleton + a coarse advisory lock around step 4 (a double-anchor is wasteful, not unsafe — the verifier accepts any valid root the leaf folds to).

### 5. Public verify surface

```ts
// GET /v1/round/:id/proof  (PUBLIC — no requireUser; proofs are meant to be shared)
// → { round: {asset, openDir, openLev, stake, cfg},
//     prices: { entry: SignedPriceUpdate, exit: SignedPriceUpdate, actions: SignedPriceUpdate[] },
//     result: {...}, leafHash,
//     anchor?: { merkleRoot, merkleProof, anchorTx, network } }   // anchor present once batched

// @perps/engine + one Pyth dep — the portable verifier
function verifyRoundProof(bundle): {
  signatures: boolean;        // each signed Pyth update verifies against the guardian set
  recompute: boolean;         // settleRound(decoded inputs) === result
  leaf: boolean;              // roundLeaf(...) === leafHash
  merkle: boolean | null;     // leafHash folds to merkleRoot via merkleProof; null if not yet anchored
  onChain: boolean | null;    // merkleRoot equals the root in anchorTx's memo; null unless an RPC is provided
  ok: boolean;                // see below
}
```

**`ok` semantics (Stage A vs B):** `ok` always requires `signatures && recompute && leaf`. When the bundle has no `anchor` yet (settled but not batched), `merkle`/`onChain` are `null` and do not gate `ok` — a freshly-settled round is fully verifiable on provenance + recompute before it is anchored. Once `anchor` is present, `ok` additionally requires `merkle === true`; `onChain` is an optional stronger check that only runs when the caller supplies a Solana RPC (it is never required for `ok`, since the memo's existence is independently checkable on any explorer).

- The verifier is **mostly `@perps/engine`** (`decodePythPrice` → `settleRound` → `roundLeaf` → `verifyMerkle`) + **one external dependency** for Pyth/Wormhole signature verification of the binary update (library pinned in the plan, e.g. `@pythnetwork/pyth-solana-receiver` parsing or `@certusone/wormhole-sdk`).
- **Tests** use synthetic signed updates and skip real signature verification (assert structure + recompute + leaf + merkle). A **gated live smoke** does the real Pyth signature check + a real devnet memo post.
- A polished public "verify my round" web page is a thin follow-on; the endpoint + the verifier function are the substance of this design.

## Config / env (server)

```
ANCHOR_NETWORK=devnet         # devnet | mainnet-beta | off (default off)
ANCHOR_RELAYER_SECRET=<base58> # devnet keypair; worker no-ops without it
ANCHOR_RPC_URL=               # optional override (default: cluster public RPC)
ANCHOR_INTERVAL_MS=10000      # batch cadence
ANCHOR_BATCH_MAX=500          # rounds per batch
```

The worker is off by default; turning it on is a deploy-time decision. Mainnet is a single `ANCHOR_NETWORK` flip + a funded mainnet keypair (custody handled then, not now).

## Data flow (end to end)

`open` stamps entry, stores the entry `SignedPriceUpdate` (role=entry) → `action` stamps + stores each action update (role=action, seq) → `close` stamps exit (role=exit), settles, computes `leafHash` from the stored commitments + result, writes it on the round → **anchor worker** batches un-anchored leaves, posts the Merkle root to Solana, writes `round_anchors` → `GET /v1/round/:id/proof` returns the bundle → **anyone** runs `verifyRoundProof`.

## Testing strategy

- **Unit (`@perps/engine`):** `roundLeaf` determinism (same data → same hash; any field change → different hash); `decodePythPrice` matches the settlement decode; Merkle build/proof/verify on synthetic leaves (incl. odd-count and single-leaf trees).
- **Integration (server, pglite + stub feed):** `open → action → close → GET /proof` returns a complete bundle with a synthetic signed update per stamped price + a correct `leafHash`; the proof endpoint is public (no auth) and 404s on unknown id.
- **Anchor worker (fakeSink):** settle N rounds → run one batch → each round gets a `round_anchors` row whose `merkleProof` `verifyMerkle`s to the stored `merkleRoot`; re-running the worker anchors nothing new (idempotent).
- **Gated live smokes (network, skip by default):** fetch a real Hermes `/latest` signed update and verify its guardian signature; post a real **devnet** SPL Memo and read it back.

## Security considerations

- **Capture-at-stamp:** signed updates are stored when the price is stamped, never refetched — removes any Hermes retention dependency and prevents a swapped-update attack.
- **Leaf binds the signed blob** (`updateHash`) so the stored decoded price cannot diverge from the signed source.
- **Public `/proof` endpoint** has no auth (by design) → add basic rate-limiting (DoS surface).
- **Relayer key:** devnet only here (low stakes); mainnet key custody is a Stage-B-on-mainnet concern, deferred.
- **Determinism:** the canonical verifier is `@perps/engine` (JS, IEEE-754). Cross-language re-implementations are the third party's responsibility; we publish the canonical JS.

## Sequencing

Stage A (provenance + recompute + `/proof` + verifier) is shippable on its own and delivers most of the value. Stage B (Solana anchor + Merkle proofs + on-chain check) layers on. Both belong to one implementation plan, built A-then-B, each behind tests.

## Dependencies & integration with 1.2

- **Feed:** extend `PriceTick`/`SignedPriceUpdate`, capture in `makeHermesFeed`, synthesize in `makeStubFeed`.
- **`rounds.open/action/close`:** persist the signed update with each stamped price; compute + store `leafHash` at close. (Settlement math unchanged.)
- **Schema:** `round_price_proofs` table, `rounds.leafHash` column, `round_anchors` table + a Drizzle migration.
- **`@perps/engine`:** add `roundLeaf`, `decodePythPrice`, `RoundLeafData`/commitments, and the Merkle helpers (shared with the verifier).
- **New:** `server/src/anchor/` (sink + worker), `GET /v1/round/:id/proof` route (public), env additions, the gated live smokes.
- **One external dep** for Pyth signature verification (pinned in the plan).

## Risks / open questions

1. **Pyth signature-verification library.** Pin the exact library + API for verifying a Hermes binary accumulator update off-chain (candidate: `@pythnetwork/pyth-solana-receiver` parsing, or `@certusone/wormhole-sdk` VAA verification). Confirm it runs in plain Node without a Solana connection. *(Resolve in the plan's first verifier task.)*
2. **Hermes `binary.data` shape.** Confirm live that `/v2/updates/price/latest?parsed=true&encoding=hex` returns `binary.data[0]` as expected, and how multiple feed ids map into one update. *(Quick live check in the feed task.)*
3. **Worker as a second single-instance process.** Deployment runs exactly one anchor worker (like the deferred autonomous settler). Decide whether to fold both into one "background worker" dyno later.
4. **Float determinism** for non-JS verifiers — accepted; canonical verifier is the published JS engine.
