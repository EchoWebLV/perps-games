/**
 * USDC base-unit ⇄ cents scale (real-money rails, spec §5 / §109).
 *
 * The ledger speaks integer **cents**; USDC on-chain speaks **base units** (6 decimals,
 * 1 USDC = 1_000_000 base units). The whole money path is BigInt-only on purpose:
 * never go through `Number`/`uiAmount` (a float can silently drop or mint sub-cent value
 * on a real balance). Boot MUST assert the configured USDC mint has exactly
 * {@link USDC_DECIMALS} decimals before any of this is trusted.
 */

/** USDC has 6 decimals on Solana mainnet. Boot-asserted against the on-chain mint (spec §5). */
export const USDC_DECIMALS = 6;

/** 1 cent = $0.01 = 10^(USDC_DECIMALS - 2) = 10_000 USDC base units. */
export const BASE_UNITS_PER_CENT = 10_000n;

/** Exact cents → USDC base units. BigInt-only; no rounding can occur. */
export function centsToBaseUnits(cents: bigint): bigint {
  return cents * BASE_UNITS_PER_CENT;
}

/**
 * Exact USDC base units → cents. **Throws on any non-zero remainder** — sub-cent dust
 * must fail loudly, never round (spec §5: a deposit/withdraw whose on-chain delta is not a
 * whole number of cents is a mismatch, not something to silently truncate).
 */
export function baseUnitsToCents(baseUnits: bigint): bigint {
  if (baseUnits % BASE_UNITS_PER_CENT !== 0n) {
    throw new Error(
      `baseUnitsToCents: ${baseUnits} base units is not a whole number of cents ` +
        `(sub-cent dust; refusing to round)`,
    );
  }
  return baseUnits / BASE_UNITS_PER_CENT;
}
