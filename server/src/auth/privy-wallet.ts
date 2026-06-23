export interface LinkedAccount {
  type?: string;
  chain_type?: string;
  connector_type?: string;
  address?: string;
  first_verified_at?: number | null;
}

/**
 * Deterministically select the user's embedded Solana wallet address.
 * Earliest-verified wins; ties (or missing timestamps) break by address order.
 * Returns null if the user has no embedded Solana wallet. Calls `onMultiple` if >1 exist
 * (a non-deterministic source we want to know about — see spec §4).
 */
export function pickEmbeddedSolanaWallet(
  linkedAccounts: LinkedAccount[],
  onMultiple?: (count: number) => void,
): string | null {
  const wallets = (linkedAccounts ?? []).filter(
    (a) => a.type === "wallet" && a.chain_type === "solana" && a.connector_type === "embedded" && !!a.address,
  );
  if (wallets.length === 0) return null;
  if (wallets.length > 1) onMultiple?.(wallets.length);
  wallets.sort((a, b) => {
    const ta = a.first_verified_at ?? Number.MAX_SAFE_INTEGER;
    const tb = b.first_verified_at ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return (a.address as string).localeCompare(b.address as string);
  });
  return wallets[0].address as string;
}
