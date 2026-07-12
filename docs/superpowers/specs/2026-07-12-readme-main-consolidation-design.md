# Repository README and Main Consolidation Design

## Goal

Give Perps Rider a useful public root README that helps a developer run the project quickly while still giving hackathon judges immediate access to the live game, Seeker APK, deployed Solana programs, and technical proof.

After the README is verified, consolidate the completed feature branch onto `main` without deleting local artifacts or rewriting history.

## Audience and priority

The README is developer-first with a compact judge-facing opening. Its order is:

1. Product identity, one-line explanation, and live links.
2. Fast local setup.
3. Architecture and repository map.
4. Component-specific development commands.
5. Deployed Devnet programs and verification evidence.
6. Current scope and limitations.

This order lets a developer reach a running build quickly while keeping the project's MagicBlock hackathon value obvious above the fold.

## README content

### Opening

- Use the canonical Perps Rider name.
- Explain the core mechanic in one sentence: a live perpetual-futures position expressed as a synthwave driving game.
- Link directly to the deployed web game and downloadable Seeker APK.
- State clearly that the current deployment uses Solana Devnet.

### Developer quickstart

- List supported prerequisites based on repository configuration.
- Provide copyable commands from a fresh clone through install and local development.
- Keep web client, API server, Anchor programs, and Android build commands distinct.
- Do not publish secrets or suggest committing environment files.

### Architecture

Include one compact Mermaid diagram showing the client surfaces, Railway account API, Solana Devnet programs, MagicBlock Ephemeral Rollup, Pyth Lazer feeds, and MagicBlock VRF. Follow it with a short explanation of which system owns money, game state, and soft-economy state.

### Repository map

Document the active packages and avoid presenting experiments as production components:

- `redline3d/`: Three.js game, web landing page, PWA, and Capacitor Android app.
- `server/`: account and economy API.
- `onchain/raider/`: Anchor workspace containing the game and crate-roll programs.
- `sim/`: deterministic mechanics simulation and tests.
- `docs/`: designs, plans, research, submission material, and verification evidence.
- `journey/`, `prototype/`, and `spikes/`: historical design exploration and technical probes.

### On-chain references

Publish both project-owned Devnet program IDs with raw Solana Explorer URLs:

- Raider: `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv`
- Crate Roll: `9MLzyBc2Nz4sqcnPnCsejMRGGnKMi9nepU3fSE1ZJUgG`

Supporting MagicBlock program IDs may be documented separately, clearly labeled as external dependencies rather than project-owned deployments.

### Evidence and limitations

- Link to `onchain/raider/RESULT.md` for verified on-chain behavior.
- Link to the hackathon submission material for the deeper product narrative.
- State that this is a Devnet hackathon build and not a production financial product.
- Avoid claims contradicted by the current implementation, especially older crate-pricing or randomness descriptions.

## Visual treatment

Use existing repository assets only. Keep the README readable in GitHub light and dark themes. Prefer a real project image or logo if a stable tracked asset exists; otherwise use a strong text heading rather than adding a new generated asset.

Badges are limited to information that can be kept accurate. The live game, APK, Devnet, and license status should be plain text links when a badge would add noise or make an unverifiable claim.

## Verification

Before committing the README:

- Verify every referenced local file exists.
- Verify every command matches a package script or documented toolchain command.
- Verify the live game, APK, and both Explorer URLs are syntactically correct.
- Scan for placeholder markers and stale `Perps Raider` naming.
- Run the relevant documentation/link checks available locally.

## Git integration

1. Preserve the untracked `artifacts/` directory and any unrelated user changes.
2. Commit the README implementation on the active branch after verification.
3. Confirm `main` is an ancestor or merge cleanly without rewriting either branch.
4. Update local `main` so it contains every completed commit from the active branch.
5. Re-run branch and working-tree verification on `main`.
6. Push `main` to `origin` only after the local integration and verification succeed.

No force push, destructive reset, or history rewrite is permitted.
