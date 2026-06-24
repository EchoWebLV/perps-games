export interface LinkedAccount {
  type?: string;
  chain_type?: string;
  connector_type?: string;
  address?: string;
  first_verified_at?: number | null;
}

/**
 * Select the user's embedded Solana wallet address. A caller-provided preferred
 * address wins only when it is one of the verified embedded wallets.
 * Otherwise earliest-verified wins; ties (or missing timestamps) break by address order.
 * Returns null if the user has no embedded Solana wallet. Calls `onMultiple` if >1 exist
 * (a non-deterministic source we want to know about — see spec §4).
 */
export function pickEmbeddedSolanaWallet(
  linkedAccounts: LinkedAccount[],
  onMultiple?: (count: number) => void,
  preferredAddress?: string | null,
): string | null {
  const wallets = (linkedAccounts ?? []).filter(
    (a) => a.type === "wallet" && a.chain_type === "solana" && a.connector_type === "embedded" && !!a.address,
  );
  if (wallets.length === 0) return null;
  if (wallets.length > 1) onMultiple?.(wallets.length);
  if (preferredAddress) {
    const preferred = wallets.find((a) => a.address === preferredAddress);
    if (preferred?.address) return preferred.address;
  }
  wallets.sort((a, b) => {
    const ta = a.first_verified_at ?? Number.MAX_SAFE_INTEGER;
    const tb = b.first_verified_at ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return (a.address as string).localeCompare(b.address as string);
  });
  return wallets[0].address as string;
}
