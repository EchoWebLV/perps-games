import type { Api, WalletBalanceResult } from "./api";
import type { DepositBuildResult } from "./play-funding";
import type { SolanaWalletPort } from "./solana-wallet";

export class WalletMismatchError extends Error {
  constructor() {
    super("wallet_mismatch");
    this.name = "WalletMismatchError";
  }
}

export interface HydratedBoundWallet {
  boundWalletAddress: string;
  walletBalance: number | null;
}

export async function hydrateBoundWallet(input: {
  walletBalance: () => Promise<WalletBalanceResult>;
}): Promise<HydratedBoundWallet> {
  const res = await input.walletBalance();
  return {
    boundWalletAddress: res.wallet ?? "",
    walletBalance: res.wallet ? res.balance : null,
  };
}

export async function ensureWalletConnection(input: {
  walletPort: SolanaWalletPort | null;
  connectedWalletAddress: string;
  boundWalletAddress: string;
  loadWalletPort: () => SolanaWalletPort;
  connectAndBindWallet: (port: SolanaWalletPort) => Promise<{ address: string; label?: string }>;
}): Promise<{
  walletPort: SolanaWalletPort;
  connectedWalletAddress: string;
  boundWalletAddress: string;
}> {
  if (input.walletPort && input.connectedWalletAddress) {
    return {
      walletPort: input.walletPort,
      connectedWalletAddress: input.connectedWalletAddress,
      boundWalletAddress: input.boundWalletAddress || input.connectedWalletAddress,
    };
  }

  const walletPort = input.walletPort ?? input.loadWalletPort();
  if (!input.boundWalletAddress) {
    const bound = await input.connectAndBindWallet(walletPort);
    return {
      walletPort,
      connectedWalletAddress: bound.address,
      boundWalletAddress: bound.address,
    };
  }

  const connected = await walletPort.connect();
  if (connected.address !== input.boundWalletAddress) throw new WalletMismatchError();
  return {
    walletPort,
    connectedWalletAddress: connected.address,
    boundWalletAddress: input.boundWalletAddress,
  };
}

export async function submitDeposit(input: {
  port: Pick<SolanaWalletPort, "signTransaction" | "signAndSendTransaction">;
  deposit: DepositBuildResult;
  api: Pick<Api, "depositSend">;
}): Promise<string> {
  const txBase64 = typeof input.deposit === "string" ? input.deposit : input.deposit.txBase64;
  if (input.port.signAndSendTransaction) return input.port.signAndSendTransaction(txBase64);

  const signedTxBase64 = await input.port.signTransaction(txBase64);
  if (typeof input.deposit === "string" || !input.deposit.depositIntent) {
    throw new Error("deposit_intent_missing");
  }
  return (await input.api.depositSend({
    depositIntent: input.deposit.depositIntent,
    signedTxBase64,
  })).txSig;
}
