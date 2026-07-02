export type WalletTarget = "auto" | "web" | "seeker";
export type ResolvedWalletTarget = "web" | "seeker";

export interface SolanaWalletPort {
  kind: "web-standard" | "mobile-wallet-adapter";
  connect(): Promise<{ address: string; label?: string }>;
  /** Silent session restore: resolve the address ONLY if a login already exists (never shows
   *  a login UI); null when there is nothing to restore. Lets the game show a returning
   *  player's balance at boot without ambushing a fresh visitor with a modal. */
  reconnect?(): Promise<{ address: string } | null>;
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

async function loadWalletStandardPort(): Promise<SolanaWalletPort> {
  const { createWalletStandardPort } = await import("./wallet-standard-port");
  return createWalletStandardPort();
}

function isMobileWalletUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const text = `${error.name} ${error.message}`.toLowerCase();
  if (/reject|denied|cancel/.test(text)) return false;

  return (
    /wallet.*not.*found/.test(text) ||
    /not.*found.*wallet/.test(text) ||
    /wallet.*unavailable/.test(text) ||
    /unavailable.*wallet/.test(text) ||
    /no.*wallet/.test(text)
  );
}

function withAutoWebFallback(mobilePort: SolanaWalletPort): SolanaWalletPort {
  let activePort = mobilePort;

  const loadWebPort = async () => {
    activePort = await loadWalletStandardPort();
    return activePort;
  };

  return {
    kind: mobilePort.kind,
    async connect() {
      try {
        return await activePort.connect();
      } catch (error) {
        if (!isMobileWalletUnavailableError(error)) throw error;

        return (await loadWebPort()).connect();
      }
    },
    disconnect() {
      return activePort.disconnect();
    },
    currentAddress() {
      return activePort.currentAddress();
    },
    signMessage(message) {
      return activePort.signMessage(message);
    },
    signTransaction(txBase64) {
      return activePort.signTransaction(txBase64);
    },
    signAndSendTransaction(txBase64) {
      if (!activePort.signAndSendTransaction) {
        throw new Error("wallet_sign_and_send_transaction_unsupported");
      }

      return activePort.signAndSendTransaction(txBase64);
    },
  };
}

export async function loadSolanaWalletPort(target: WalletTarget = "auto"): Promise<SolanaWalletPort> {
  const resolvedTarget = chooseWalletTarget(target);

  if (resolvedTarget === "seeker") {
    try {
      const { createMobileWalletPort } = await import("./mobile-wallet-port");
      const mobilePort = createMobileWalletPort();
      return target === "auto" ? withAutoWebFallback(mobilePort) : mobilePort;
    } catch (error) {
      if (target === "auto") {
        return loadWalletStandardPort();
      }

      throw error;
    }
  }

  return loadWalletStandardPort();
}

export function createWalletPortPreloader(loadWalletPort: () => Promise<SolanaWalletPort>) {
  let walletPort: SolanaWalletPort | null = null;
  let loading: Promise<SolanaWalletPort> | null = null;

  const preload = () => {
    if (walletPort) return Promise.resolve(walletPort);
    loading ??= loadWalletPort()
      .then((port) => {
        walletPort = port;
        return port;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
    return loading;
  };

  return {
    preload,
    current() {
      return walletPort;
    },
    requireReady() {
      if (walletPort) return walletPort;
      void preload();
      throw new Error("wallet_port_loading");
    },
  };
}
