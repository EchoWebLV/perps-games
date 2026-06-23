import { PrivyClient, InvalidAuthTokenError } from "@privy-io/node";
import { pickEmbeddedSolanaWallet } from "./privy-wallet.js";

/** Identity + embedded-wallet adapter. Verified against @privy-io/node@0.22.0 (snake_case fields). */
export interface PrivyAuth {
  /** verify a Bearer access-token JWT → the Privy DID (throws AuthError on invalid/expired) */
  verifyAccessToken(token: string): Promise<string>;
  /** the user's embedded Solana address, or null if none yet */
  fetchSolanaWallet(did: string): Promise<string | null>;
}

export class AuthError extends Error {}

export interface PrivyEnv {
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  PRIVY_VERIFICATION_KEY?: string;
}

/** null when keys are absent → the server runs dev-only auth. */
export function makePrivyAuth(env: PrivyEnv): PrivyAuth | null {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) return null;
  const privy = new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    jwtVerificationKey: env.PRIVY_VERIFICATION_KEY, // offline verify when provided
  });
  return {
    async verifyAccessToken(token) {
      try {
        const claims = await privy.utils().auth().verifyAccessToken(token);
        return claims.user_id; // snake_case; the DID
      } catch (e) {
        if (e instanceof InvalidAuthTokenError) throw new AuthError("invalid token");
        throw e;
      }
    },
    async fetchSolanaWallet(did) {
      const user = await privy.users()._get(did); // underscore: Stainless reserves get()
      return pickEmbeddedSolanaWallet(user.linked_accounts as any, (n) =>
        // TODO(alerting): route [multiple_embedded_solana_wallets] to the real alert sink
        // (spec §12), as with wallet_rebind_attempt — a bare console.warn must not be the
        // only signal for an ambiguous real-money payout identity in a real-money deployment.
        console.warn(`[multiple_embedded_solana_wallets] did=${did} count=${n}`),
      );
    },
  };
}
