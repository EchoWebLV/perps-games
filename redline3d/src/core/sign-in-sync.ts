import type { Api } from "./api";
import type { AuthProvider } from "./auth";
import type { AccountSync, AccountSnapshot } from "./account-sync";
import type { SolanaWalletPort } from "./solana-wallet";
import { connectAndBindWallet } from "./wallet-binding";

/** On sign-in: bind the Privy wallet to the server (nonce challenge → session token), adopt that
 *  token into the auth provider, then hydrate coins/scrap/cars. Pure — `main.ts` supplies the port
 *  (a thin adapter over the live GameSession) and the local snapshot. */
export async function bindAndHydrate(input: {
  api: Pick<Api, "bindWalletChallenge" | "bindWallet">;
  auth: Pick<AuthProvider, "adoptSession">;
  port: Pick<SolanaWalletPort, "connect" | "signMessage">;
  accountSync: Pick<AccountSync, "hydrate">;
  localSnapshot: AccountSnapshot;
  /** Identity-gate sign-ins must not continue as an empty local account when Railway is offline. */
  requireServerHydration?: boolean;
}): Promise<"seeded" | "server" | "offline"> {
  const bound = await connectAndBindWallet({ port: input.port as SolanaWalletPort, api: input.api });
  if (bound.session) input.auth.adoptSession?.(bound.session);
  const outcome = await input.accountSync.hydrate(input.localSnapshot);
  if (input.requireServerHydration && outcome === "offline") throw new Error("account_hydration_failed");
  return outcome;
}
