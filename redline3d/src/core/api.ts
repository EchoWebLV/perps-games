import { getDevUserId } from "./identity";
import type { AuthProvider } from "./auth";

export type Asset = "BTC" | "ETH" | "SOL";
export type Dir = 1 | -1;

export interface MeResult { userId: string; balance: number; cars: { carId: string }[]; openRoundId: string | null; }
export interface OpenResult { roundId: string; asset: Asset; dir: Dir; lev: number; stake: number; entryRaw: number; entryTsUs: number; }
export interface CloseResult { outcome: string; payoutCoins: number; pnlCoins: number; equity: number; exitRaw: number; balance: number; }
/** live read-only mark: the server's CURRENT equity for an open round (what the client displays) */
export interface MarkResult { status: "open" | "settled"; stale: boolean; outcome: string | null; equity: number; payoutCoins: number; buffer: number; }

export type ApiErrorCode =
  | "unauthorized" | "insufficient_balance" | "round_already_open" | "round_not_open"
  | "round_not_found" | "feed_halt" | "bad_request" | "network" | "server";

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, public status: number) { super(code); this.name = "ApiError"; }
}

/** map an HTTP status + body.error string to a typed code */
function codeFor(status: number, bodyError?: string): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 402) return "insufficient_balance";
  if (status === 404) return "round_not_found";
  if (status === 503) return "feed_halt";
  if (status === 409) return bodyError === "round_not_open" ? "round_not_open" : "round_already_open";
  if (status === 400) return "bad_request";
  return "server";
}

export interface Api {
  me(): Promise<MeResult>;
  openRound(p: { asset: Asset; dir: Dir; lev: number; stake: number }): Promise<OpenResult>;
  roundAction(p: { roundId: string; actionId: string; kind: "flip" | "lever"; dir?: Dir; lev?: number }): Promise<void>;
  closeRound(p: { roundId: string; reason: "cashout" | "expire" }): Promise<CloseResult>;
  markRound(roundId: string): Promise<MarkResult>;
}

export interface ApiOpts { fetch?: typeof fetch; baseUrl?: string; auth?: Pick<AuthProvider, "authHeaders">; userId?: string; }

export function createApi(opts: ApiOpts = {}): Api {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (opts.baseUrl ?? (import.meta.env?.VITE_API_BASE as string) ?? "http://localhost:8080").replace(/\/$/, "");
  // back-compat: if no auth provider, fall back to the dev header (existing behavior)
  const headers = async (): Promise<Record<string, string>> =>
    opts.auth ? await opts.auth.authHeaders() : { "x-dev-user": opts.userId ?? getDevUserId() };

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await doFetch(baseUrl + path, {
        method,
        headers: { ...(await headers()), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("network", 0);
    }
    if (!r.ok) {
      let err: string | undefined;
      try { err = (await r.json())?.error; } catch { /* ignore */ }
      throw new ApiError(codeFor(r.status, err), r.status);
    }
    return (await r.json()) as T;
  }

  return {
    me: () => call<MeResult>("GET", "/v1/me"),
    openRound: (p) => call<OpenResult>("POST", "/v1/round/open", p),
    roundAction: (p) => call<void>("POST", "/v1/round/action", p),
    closeRound: (p) => call<CloseResult>("POST", "/v1/round/close", p),
    markRound: (id) => call<MarkResult>("GET", `/v1/round/${id}/mark`),
  };
}
