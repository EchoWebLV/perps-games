import { USDC_DECIMALS } from "../money/usdc.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";

export interface MintInfo { decimals: number; programAddress: string; }
/** A function that fetches on-chain mint info for a mint address. */
export type FetchMintInfo = (mint: string) => Promise<MintInfo>;

/** Boot guard (spec §5): refuse to run unless the configured USDC mint is 6-decimal legacy SPL. */
export async function assertUsdcMint(fetch: FetchMintInfo, mint: string): Promise<void> {
  const info = await fetch(mint);
  if (info.decimals !== USDC_DECIMALS) {
    throw new Error(`USDC mint ${mint} has ${info.decimals} decimals, expected ${USDC_DECIMALS}`);
  }
  if (info.programAddress !== LEGACY_TOKEN_PROGRAM) {
    throw new Error(`USDC mint ${mint} is not legacy SPL (program ${info.programAddress})`);
  }
}
