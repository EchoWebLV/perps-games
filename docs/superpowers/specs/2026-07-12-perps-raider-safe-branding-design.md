# Perps Rider Safe Branding Design

## Goal

The active product must be presented as **Perps Rider**, never as the former product name.

## Active Surfaces

- Web and PWA title metadata
- Android launcher and activity labels
- Wallet-signing prompts
- Client package metadata
- Runtime console messages
- Current build instructions and operator-facing messages

## Compatibility Exceptions

The following legacy technical identifiers remain unchanged because renaming them would create a second Android app, discard local saves, or break deployed infrastructure:

- Android application ID and Java namespace: `xyz.redline.game`
- Existing `redline.*` local-storage and crash-recovery keys
- Railway service names and generated domains
- The existing `redline3d/` source directory
- Historical journey snapshots and archived design documents

The automotive term “redline” also remains where it describes the tachometer’s high-RPM zone rather than the product brand.

## Verification

Active user-facing files and wallet-signing tests must use `Perps Rider`. Existing Android and local-storage identifiers must remain byte-for-byte compatible.

