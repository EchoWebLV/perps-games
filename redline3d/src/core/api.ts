import { getDevUserId } from "./identity";
import type { AuthProvider } from "./auth";

export type Asset = "BTC" | "ETH" | "SOL";
export type Dir = 1 | -1;
export type TradeOutcome = "cashout" | "cap" | "liq" | "time";

export interface TradeRecordInput {
  id: string;
  asset: Asset;
  dir: Dir;
  lev: number;
  stakeBase: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  outcome: TradeOutcome;
  payoutBase: number;
}

export interface TradeHistoryItem extends TradeRecordInput {
  walletPublicKey: string;
  pnlBase: number;
  settledAt: string;
}

export interface TradeHistoryPage {
  items: TradeHistoryItem[];
  nextCursor: string | null;
}

export interface MeResult { userId: string; balance: number; coins: number; scrap: number; cars: { carId: string; count: number; acquiredAt?: string }[]; openRoundId: string | null; access: string[]; levels?: { turbo: number; tank: number; suspension: number }; driverName?: string | null; }
export interface OpenResult { roundId: string; asset: Asset; dir: Dir; lev: number; stake: number; entryRaw: number; entryTsUs: number; }
export interface CloseResult { outcome: string; payoutCoins: number; pnlCoins: number; equity: number; exitRaw: number; balance: number; }
/** live read-only mark: the server's CURRENT equity for an open round (what the client displays) */
export interface MarkResult { status: "open" | "settled"; stale: boolean; outcome: string | null; equity: number; payoutCoins: number; buffer: number; }
export interface WalletBalanceResult { wallet: string | null; balance: number; }

export type ApiErrorCode =
  | "unauthorized" | "insufficient_balance" | "round_already_open" | "round_not_open"
  | "round_not_found" | "trade_id_conflict" | "trade_wallet_mismatch"
  | "feed_halt" | "bad_request" | "network" | "server";

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, public status: number, public bodyError?: string) { super(code); this.name = "ApiError"; }
}

/** map an HTTP status + body.error string to a typed code */
function codeFor(status: number, bodyError?: string): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 402) return "insufficient_balance";
  if (status === 404) return "round_not_found";
  if (status === 503) return "feed_halt";
  if (status === 409) {
    if (bodyError === "round_not_open") return "round_not_open";
    if (bodyError === "trade_id_conflict") return "trade_id_conflict";
    if (bodyError === "trade_wallet_mismatch") return "trade_wallet_mismatch";
    return "round_already_open";
  }
  if (status === 400) return "bad_request";
  return "server";
}

export interface Api {
  me(): Promise<MeResult>;
  coinsEarn(p: { amount: number; ref: string }): Promise<{ coins: number }>;
  coinsSpend(p: { amount: number; ref: string }): Promise<{ coins: number }>;
  scrapEarn(p: { amount: number; ref: string }): Promise<{ scrap: number }>;
  scrapSpend(p: { amount: number; ref: string }): Promise<{ scrap: number }>;
  inventoryGrant(p: { carId: string }): Promise<{ carId: string; isNew: boolean; count: number }>;
  inventoryMelt(p: { carId: string }): Promise<{ carId: string; melted: boolean; count: number }>;
  migrate(p: { coins: number; scrap: number; cars: Record<string, number>; levels?: { turbo: number; tank: number; suspension: number } }): Promise<{ seeded: boolean; reason?: string }>;
  /** authoritative upgrade purchase — the server debits coins AND scrap and returns the new level. */
  upgradesBuy(p: { track: "turbo" | "tank" | "suspension" }): Promise<{ track: string; level: number; coins: number; scrap: number }>;
  /** Read welcome eligibility without consuming the once-per-account claim. */
  openCrate(p: {
    crateKey: "wooden" | "silver" | "gold";
    payment: "coins" | "sol" | "gift";
    vrfBytes: string;
    solSignature?: string;
  }): Promise<{
    carId: string;
    isNew: boolean;
    count: number;
    scrap: number;
    scrapTotal: number;
    coins: number;
    levelKey: string | null;
    pity: { wooden: number; silver: number; gold: number };
  }>;
  welcomeStatus(): Promise<{ pending: boolean }>;
  /** claim the first-login welcome crate ONCE PER ACCOUNT (server-side). granted=true only the first time. */
  claimWelcome(): Promise<{ granted: boolean }>;
  /** redeem an access code for THIS account. Server-authoritative + idempotent per account+code:
   *  granted=true ONLY the first time this account redeems this code, false once already recorded. */
  redeemAccess(code: string): Promise<{ granted: boolean }>;
  setDriverName(name: string): Promise<{ driverName: string }>;
  openRound(p: { asset: Asset; dir: Dir; lev: number; stake: number }): Promise<OpenResult>;
  roundAction(p: { roundId: string; actionId: string; kind: "flip" | "lever"; dir?: Dir; lev?: number }): Promise<void>;
  closeRound(p: { roundId: string; reason: "cashout" | "expire" }): Promise<CloseResult>;
  markRound(roundId: string): Promise<MarkResult>;
  recordTrade(input: TradeRecordInput, expectedWallet?: string): Promise<TradeHistoryItem>;
  listTrades(cursor?: string): Promise<TradeHistoryPage>;
  bindWalletChallenge(wallet: string): Promise<{ challenge: string; message: string; wallet: string; expiresAt: string }>;
  /** One of the two signature fields the server accepts: `signature` is the 0x-hex EIP-191
   *  signature (EVM rail, preferred), `signatureBase58` the ed25519 one (Solana rail). */
  bindWallet(input: { challenge: string; signature?: string; signatureBase58?: string }): Promise<{
    wallet: string;
    token?: string;
    userId?: string;
  }>;
  /** build an unsigned USDC deposit tx (connected wallet → treasury) for the client to sign + broadcast */
  depositBuild(amountCents: number): Promise<{ txBase64: string; depositIntent: string; expiresAt: string }>;
  depositSend(input: { depositIntent: string; signedTxBase64: string }): Promise<{ txSig: string }>;
  /** on-chain USDC currently sitting in the user's connected wallet */
  walletBalance(): Promise<WalletBalanceResult>;
}

export interface ApiOpts {
  fetch?: typeof fetch;
  baseUrl?: string;
  auth?: Pick<AuthProvider, "authHeaders" | "logout">;
  userId?: string;
  timeoutMs?: number;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function resolveBaseUrl(explicitBaseUrl?: string): string {
  const configured = explicitBaseUrl ?? (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";
  try {
    const url = new URL(configured);
    const page = globalThis.location;
    if (isLoopbackHost(url.hostname) && page?.hostname && !isLoopbackHost(page.hostname)) {
      return `${page.protocol}//${page.hostname}:8080`;
    }
  } catch {
    // Fall back to the configured string; the fetch layer will surface bad URLs as network errors.
  }
  return configured;
}

export function createApi(opts: ApiOpts = {}): Api {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = resolveBaseUrl(opts.baseUrl).replace(/\/$/, "");
  // Bound every request so a stalled connection can't hang the UI on "Launching…"/"Settling…"
  // forever. An abort surfaces as a network ApiError, which open()/close() already handle.
  const timeoutMs = opts.timeoutMs ?? 12_000;
  // back-compat: if no auth provider, fall back to the dev header (existing behavior)
  const headers = async (): Promise<Record<string, string>> =>
    opts.auth ? await opts.auth.authHeaders() : { "x-dev-user": opts.userId ?? getDevUserId() };

  function shouldRefreshAuth(status: number, bodyError?: string): boolean {
    return status === 401 && (bodyError === "invalid_token" || bodyError === "unauthorized");
  }

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    requestHeaders?: Record<string, string>,
    timeoutOverrideMs?: number,
    retriedAuth = false,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutOverrideMs ?? timeoutMs);
    try {
      let r: Response;
      try {
        r = await doFetch(baseUrl + path, {
          method,
          headers: { ...(await headers()), ...requestHeaders, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
          // Browsers may otherwise cancel account mutations when the player closes or reloads the
          // page. These JSON payloads are tiny and fit comfortably within fetch keepalive limits.
          keepalive: method === "POST",
        });
      } catch {
        throw new ApiError("network", 0);            // offline, or an abort (timeout) fired
      }
      if (!r.ok) {
        let err: string | undefined;
        try { err = (await r.json())?.error; } catch { /* ignore */ }
        if (!retriedAuth && opts.auth?.logout && shouldRefreshAuth(r.status, err)) {
          await opts.auth.logout();
          return call<T>(method, path, body, requestHeaders, timeoutOverrideMs, true);
        }
        throw new ApiError(codeFor(r.status, err), r.status, err);
      }
      return (await r.json()) as T;
    } finally {
      clearTimeout(timer);                           // timer spans the body read too — a stalled body still aborts
    }
  }

  return {
    me: () => call<MeResult>("GET", "/v1/me"),
    coinsEarn: (p) => call("POST", "/v1/coins/earn", p),
    coinsSpend: (p) => call("POST", "/v1/coins/spend", p),
    scrapEarn: (p) => call("POST", "/v1/scrap/earn", p),
    scrapSpend: (p) => call("POST", "/v1/scrap/spend", p),
    inventoryGrant: (p) => call("POST", "/v1/inventory/grant", p),
    inventoryMelt: (p) => call("POST", "/v1/inventory/melt", p),
    migrate: (p) => call("POST", "/v1/migrate", p),
    upgradesBuy: (p) => call("POST", "/v1/upgrades/buy", p),
    openCrate: (p) => call("POST", "/v1/crates/open", p),
    welcomeStatus: () => call("GET", "/v1/welcome/status"),
    // send an empty {} body: `call` always sets content-type:application/json, and Fastify 400s an
    // empty body under that content-type. The server ignores the body.
    claimWelcome: () => call("POST", "/v1/welcome/claim", {}),
    // { code } is a real body → `call` sets content-type:application/json and Fastify accepts it.
    redeemAccess: (code) => call("POST", "/v1/access/redeem", { code }),
    setDriverName: (name) => call("POST", "/v1/profile/driver-name", { name }),
    openRound: (p) => call<OpenResult>("POST", "/v1/round/open", p),
    roundAction: (p) => call<void>("POST", "/v1/round/action", p),
    closeRound: (p) => call<CloseResult>("POST", "/v1/round/close", p),
    markRound: (id) => call<MarkResult>("GET", `/v1/round/${id}/mark`),
    recordTrade: (input, expectedWallet) => call<TradeHistoryItem>(
      "POST",
      "/v1/trades",
      input,
      expectedWallet ? { "x-trade-wallet": expectedWallet } : undefined,
    ),
    listTrades: (cursor) => call<TradeHistoryPage>(
      "GET",
      `/v1/trades?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
    bindWalletChallenge: (wallet) => call("POST", "/v1/wallet/bind-challenge", { wallet }),
    bindWallet: (input) => call("POST", "/v1/wallet/bind", input),
    depositBuild: (amountCents) => call<{ txBase64: string; depositIntent: string; expiresAt: string }>("POST", "/v1/deposit/build", { amountCents }),
    depositSend: (input) => call("POST", "/v1/deposit/send", input),
    walletBalance: () => call<WalletBalanceResult>("GET", "/v1/wallet/usdc-balance"),
  };
}
