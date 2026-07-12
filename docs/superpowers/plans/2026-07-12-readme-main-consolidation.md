# Repository README and Main Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a developer-first public README with judge-facing live links and verified technical references, then fast-forward and push `main` with all completed work.

**Architecture:** The root `README.md` is the single entry point and links to existing focused documents instead of duplicating their depth. Git integration uses an ordinary fast-forward because `main` is already an ancestor of the active branch, preserving every completed commit and the untracked `artifacts/` directory.

**Tech Stack:** Markdown, Mermaid, npm workspaces, Vite, Three.js, Fastify, Anchor 0.32.1, Solana Devnet, MagicBlock Ephemeral Rollups, Pyth Lazer, Capacitor 8, Android/JDK 21, Git.

## Global Constraints

- Use `Perps Rider` everywhere in new copy.
- Do not use em dashes in new copy.
- Keep the README developer-first with a compact judge-facing opening.
- Use only tracked repository images and documents.
- Publish both project-owned Devnet program IDs and raw Explorer URLs.
- Preserve `artifacts/` and unrelated user changes.
- Do not force push, reset, or rewrite history.
- The current product is a Devnet hackathon build, not a production financial product.

---

### Task 1: Create the root README

**Files:**
- Create: `README.md`
- Reference: `redline3d/public/loadingscreen.png`
- Reference: `server/README.md`
- Reference: `redline3d/BUILD_APK.md`
- Reference: `onchain/raider/RESULT.md`
- Reference: `docs/superpowers/submission/2026-07-hackathon-submission-draft.md`

**Interfaces:**
- Consumes: existing package scripts, deployment URLs, tracked artwork, and Devnet program IDs.
- Produces: the repository's public developer and judge entry point.

- [ ] **Step 1: Confirm the missing entry point**

Run: `test -f README.md`

Expected: exit 1 because the repository currently has no root README.

- [ ] **Step 2: Create the complete README**

Create `README.md` with these exact sections and facts:

```markdown
<p align="center">
  <img src="redline3d/public/loadingscreen.png" alt="Perps Rider" width="720" />
</p>

<h1 align="center">Perps Rider</h1>

<p align="center">
  A live perpetual-futures position you drive through a synthwave arcade racer.
</p>

<p align="center">
  <a href="https://redline-web-production.up.railway.app/play/">Play on the web</a>
  ·
  <a href="https://redline-web-production.up.railway.app/downloads/perps-rider.apk">Download the Seeker APK</a>
  ·
  Solana Devnet
</p>

Perps Rider turns a leveraged BTC, ETH, or SOL position into a driving game. Direction chooses LONG or SHORT, the tachometer controls leverage, live Pyth prices move the position, and the on-chain program decides liquidation, cap, timeout, and payout on a MagicBlock Ephemeral Rollup.

The repository contains the Three.js game, Railway-backed account service, two Anchor programs, Android/Seeker packaging, deterministic economics, simulations, and verification evidence.

## Quickstart

Requirements: Node.js 22+, npm, and Git. The basic local loop uses in-memory PGlite, so Postgres is optional.

```bash
git clone https://github.com/EchoWebLV/perps-games.git
cd perps-games
npm ci
npm ci --prefix redline3d
```

Start the API:

```bash
npm run dev --workspace @perps/server
```

In another terminal, start the game:

```bash
npm run dev --prefix redline3d -- --host 0.0.0.0
```

Open the Vite URL shown in the terminal. Guest practice works without credentials. Signed-in wallet and Devnet flows require the Vite variables used by `redline3d/.env` or your own ignored local environment file.

## Architecture

```mermaid
flowchart LR
  Web[Web and PWA] --> Game[Three.js game client]
  APK[Seeker APK] --> Game
  Game --> API[Railway Fastify API]
  API --> DB[(Postgres account and economy state)]
  Game --> Raider[Raider Anchor program]
  Game --> Crates[Crate Roll Anchor program]
  Raider --> ER[MagicBlock Ephemeral Rollup]
  ER --> Pyth[Pyth Lazer prices]
  Crates --> VRF[MagicBlock VRF]
  Raider --> L1[Solana Devnet]
  Crates --> L1
```

- Money and round settlement live in program-owned Solana accounts.
- Fast round execution and continuous settlement run on the MagicBlock Ephemeral Rollup.
- BTC, ETH, and SOL marks come from authenticated Pyth Lazer feeds.
- Crate randomness is requested through the MagicBlock VRF consumer program.
- Coins, scrap, cars, identity, and cross-device sync are maintained by the account API.

## Repository map

| Path | Purpose |
| --- | --- |
| `redline3d/` | Three.js game, landing page, PWA, Vitest suite, and Capacitor Android app |
| `server/` | Fastify account, economy, payment, and multiplayer presence API |
| `packages/engine/` | Shared deterministic leverage, settlement, and entitlement math |
| `onchain/raider/` | Anchor workspace for the Raider and Crate Roll programs |
| `sim/` | House-economics and high-leverage market simulations |
| `docs/` | Product designs, implementation plans, research, and submission material |
| `journey/`, `prototype/`, `spikes/` | Historical visual exploration and technical probes |

## Development

### Game client

```bash
npm test --prefix redline3d
npm run build --prefix redline3d
```

### API and shared engine

```bash
npm test --workspace @perps/engine
npm run build --workspace @perps/engine
npm test --workspace @perps/server
npm run build --workspace @perps/server
```

Local development can use in-memory PGlite. Durable local data uses Postgres as described in [`server/README.md`](server/README.md).

### Anchor programs

The workspace pins Anchor 0.32.1 and Solana Devnet in `onchain/raider/Anchor.toml`.

```bash
cd onchain/raider
npm ci
cargo test -p raider
anchor build
```

Devnet integration drivers spend Devnet SOL and require the configured wallet and RPC. They are intentionally separate from the default unit-test loop.

### Seeker and Android

Capacitor 8 requires JDK 21 and the Android SDK. Native builds also require `VITE_PRIVY_APP_ID` and `VITE_BASE_RPC`.

```bash
cd redline3d
npm run apk
npm run apk:serve
npm run apk:install
```

See [`redline3d/BUILD_APK.md`](redline3d/BUILD_APK.md) for toolchain setup and sideloading instructions.

## Deployed programs

Both project programs are deployed on Solana Devnet.

| Program | Address | Explorer |
| --- | --- | --- |
| Raider game and settlement | `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv` | https://explorer.solana.com/address/FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv?cluster=devnet |
| Crate Roll VRF consumer | `9MLzyBc2Nz4sqcnPnCsejMRGGnKMi9nepU3fSE1ZJUgG` | https://explorer.solana.com/address/9MLzyBc2Nz4sqcnPnCsejMRGGnKMi9nepU3fSE1ZJUgG?cluster=devnet |

MagicBlock dependencies used by the project:

| Dependency | Program address |
| --- | --- |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Task Scheduler | `Magic11111111111111111111111111111111111111` |
| VRF Program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |

## What is verified

The repository includes Devnet evidence for account delegation, authenticated price reads, deterministic integer settlement, solvency locking, value conservation, owner-only withdrawal, permissionless liveness, and continuous settlement.

- [`onchain/raider/RESULT.md`](onchain/raider/RESULT.md): on-chain test results and transaction evidence
- [`docs/superpowers/submission/2026-07-hackathon-submission-draft.md`](docs/superpowers/submission/2026-07-hackathon-submission-draft.md): product and MagicBlock submission narrative
- [`sim/README.md`](sim/README.md): house-economics simulation methodology

## Current scope

This repository is a Solana Devnet hackathon build. Devnet tokens have no monetary value. The APK is a sideloadable debug build, not a Solana dApp Store release. The system should not be treated as audited or production-ready financial software.
```

- [ ] **Step 3: Run static README checks**

Run:

```bash
test -f README.md
git diff --check
rg -n 'Perps Raider|TBD|PLACEHOLDER|—' README.md
for path in redline3d/public/loadingscreen.png server/README.md redline3d/BUILD_APK.md onchain/raider/RESULT.md docs/superpowers/submission/2026-07-hackathon-submission-draft.md sim/README.md; do test -e "$path"; done
```

Expected: `test` and the path loop exit 0; `git diff --check` prints nothing; `rg` returns no matches.

- [ ] **Step 4: Verify package commands referenced by the README**

Run:

```bash
node -e 'const fs=require("fs"); const root=require("./package.json"); const game=require("./redline3d/package.json"); const server=require("./server/package.json"); const engine=require("./packages/engine/package.json"); if(!root.workspaces.includes("server") || !game.scripts.dev || !game.scripts.build || !game.scripts.test || !game.scripts.apk || !game.scripts["apk:serve"] || !game.scripts["apk:install"] || !server.scripts.dev || !server.scripts.build || !server.scripts.test || !engine.scripts.build || !engine.scripts.test) process.exit(1); console.log("README commands verified")'
```

Expected: `README commands verified`.

- [ ] **Step 5: Commit the README**

```bash
git add README.md
git commit -m "docs: add developer repository readme"
```

Expected: one commit containing only `README.md`.

### Task 2: Verify and consolidate onto main

**Files:**
- Modify: Git branch reference `main`
- Preserve: `artifacts/`

**Interfaces:**
- Consumes: the verified README commit and all prior active-branch commits.
- Produces: a verified local and remote `main` containing the complete project history.

- [ ] **Step 1: Verify fast-forward safety and working-tree scope**

Run:

```bash
git merge-base --is-ancestor main HEAD
git status --short
git rev-list --count main..HEAD
```

Expected: ancestor check exits 0; status lists only `?? artifacts/`; the commit count is greater than zero.

- [ ] **Step 2: Fast-forward main**

Run:

```bash
git switch main
git merge --ff-only codex/magicblock-native-highway
```

Expected: branch switches to `main` and fast-forwards without conflicts.

- [ ] **Step 3: Run release verification on main**

Run each command sequentially:

```bash
npm test --workspace @perps/engine
npm run build --workspace @perps/engine
npm test --workspace @perps/server
npm run build --workspace @perps/server
npm test --prefix redline3d
npm run build --prefix redline3d
```

Expected: every command exits 0. Skipped integration tests are acceptable when they require external credentials; failures are not.

- [ ] **Step 4: Verify final branch state**

Run:

```bash
git branch --show-current
git status --short
git log -3 --oneline
git rev-list --count HEAD..codex/magicblock-native-highway
```

Expected: branch is `main`; status lists only `?? artifacts/`; branch difference is `0`.

- [ ] **Step 5: Push main**

Run: `git push origin main`

Expected: `origin/main` advances to the verified README commit without a force push.
