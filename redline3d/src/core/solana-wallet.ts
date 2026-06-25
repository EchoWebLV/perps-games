export type WalletTarget = "auto" | "web" | "seeker";
export type ResolvedWalletTarget = "web" | "seeker";

export interface SolanaWalletPort {
  kind: "web-standard" | "mobile-wallet-adapter";
  connect(): Promise<{ address: string; label?: string }>;
  disconnect(): Promise<void>;
  currentAddress(): string | null;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(txBase64: string): Promise<string>;
  signAndSendTransaction?(txBase64: string): Promise<string>;
}

export interface WalletRuntimeInfo {
  userAgent: string;
  capacitorNative: boolean;
}

export function runtimeInfo(): WalletRuntimeInfo {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const nav = globalThis.navigator;

  return {
    userAgent: nav?.userAgent ?? "",
    capacitorNative: !!cap?.isNativePlatform?.(),
  };
}

export function chooseWalletTarget(
  target: WalletTarget,
  info: WalletRuntimeInfo = runtimeInfo(),
): ResolvedWalletTarget {
  if (target === "web" || target === "seeker") {
    return target;
  }

  if (info.capacitorNative && /Android/i.test(info.userAgent)) {
    return "seeker";
  }

  if (/Seeker/i.test(info.userAgent)) {
    return "seeker";
  }

  return "web";
}

export async function loadSolanaWalletPort(target: WalletTarget = "auto"): Promise<SolanaWalletPort> {
  const resolvedTarget = chooseWalletTarget(target);

  if (resolvedTarget === "seeker") {
    const { createMobileWalletPort } = await import("./mobile-wallet-port");
    return createMobileWalletPort();
  }

  const { createWalletStandardPort } = await import("./wallet-standard-port");
  return createWalletStandardPort();
}
