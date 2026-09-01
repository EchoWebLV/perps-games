import type { Api } from "./api";
import type { AuthProvider } from "./auth";
import type { AccountSync, AccountSnapshot } from "./account-sync";
import { connectAndBindWallet } from "./wallet-binding";

/** What either rail's binder does: prove the wallet owns itself, and hand back the server session
 *  that proof earned. The Solana and EVM flavours differ only in how the message is signed. */
export interface WalletBinder<P> {
  (input: { port: P; api: Pick<Api, "bindWalletChallenge" | "bindWallet"> }): Promise<{
    address: string;
    session?: { token: string; userId: string };
  }>;
}

/** On sign-in: bind the player's wallet to the server (nonce challenge → session token), adopt that
 *  token into the auth provider, then hydrate coins/scrap/cars. Pure — `main.ts` supplies the port
 *  (a thin adapter over the live session) and the local snapshot.
 *
 *  `bind` selects the rail: the EVM one (`connectAndBindEvmWallet`) signs EIP-191 over a string,
 *  the default Solana one signs bytes. Both return the same bound shape. */
export async function bindAndHydrate<P>(input: {
  api: Pick<Api, "bindWalletChallenge" | "bindWallet">;
  auth: Pick<AuthProvider, "adoptSession">;
  port: P;
  bind?: WalletBinder<P>;
  accountSync: Pick<AccountSync, "hydrate">;
  localSnapshot: AccountSnapshot;
  /** Identity-gate sign-ins must not continue as an empty local account when Railway is offline. */
  requireServerHydration?: boolean;
}): Promise<"seeded" | "server" | "offline"> {
  const bind = input.bind ?? (connectAndBindWallet as unknown as WalletBinder<P>);
  const bound = await bind({ port: input.port, api: input.api });
  if (bound.session) input.auth.adoptSession?.(bound.session);
  const outcome = await input.accountSync.hydrate(input.localSnapshot);
  if (input.requireServerHydration && outcome === "offline") throw new Error("account_hydration_failed");
  return outcome;
}
