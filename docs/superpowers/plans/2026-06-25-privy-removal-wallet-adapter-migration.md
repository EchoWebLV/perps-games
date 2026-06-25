# Privy Removal Wallet Adapter Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Privy from the game client, auth path, and payment path while keeping one fast wallet funding flow for web and Solana Seeker.

**Architecture:** The game boots with an anonymous signed session and no wallet SDK. Wallet interaction is isolated behind a `SolanaWalletPort` that loads only from wallet-screen actions. Funding is one user-approved USDC deposit into the treasury, with optional server fee sponsorship, and every `GO!` remains a server ledger debit plus round open.

**Tech Stack:** TypeScript, Vite, Fastify, Drizzle, PGlite, Vitest, `@solana/kit@5.5.1`, `@wallet-standard/app@1.1.1`, `@solana/wallet-standard-wallet-adapter-base@1.1.5`, `@solana/wallet-adapter-base@0.9.27`, `@solana-mobile/wallet-adapter-mobile@2.2.9`, `@solana/web3.js@1.98.4`, `@noble/ed25519@3.1.0`, `bs58@6.0.0`.

## Global Constraints

- No embedded wallet provider.
- The app can load the 3D scene, menus, car picker, and lobby without wallet SDK weight or wallet modal behavior.
- Web uses Solana Wallet Standard / Solana Wallet Adapter to connect Phantom, Solflare, Backpack, and other standard wallets.
- Seeker uses Solana Mobile Wallet Adapter as the primary transport and falls back to Wallet Standard when MWA is not available.
- Wallet SDKs are dynamically imported from wallet-screen actions only.
- `GO!` must not import wallet SDKs, connect a wallet, request a signature, build a deposit, broadcast a transaction, or poll chain state.
- `GO!` does only stale round self-heal, `server cash >= playAmount` check, round open, and local gameplay start.
- Deposits use the server-authored USDC transfer shape: user USDC ATA to treasury USDC ATA, user wallet as authority, server fee-payer when configured, legacy SPL Token program.
- Server fee-payer signing starts as an environment secret for a low-balance hot fee-payer wallet.
- The fee-payer wallet must never be the treasury token authority.
- Game account auth starts as an anonymous signed session.
- Wallet binding requires a server challenge and wallet signature.
- A server user may bind one funding wallet set-once.
- Deposits credit playable `cash` only after the existing deposit confirmer records the finalized inbound transfer.
- The UI may show pending funding before finality, but playable `cash` is updated only by the server ledger.
- Old `/v1/play/payment/*` endpoints are deleted in this migration.
- Remove `@privy-io/react-auth`, React Privy island, Privy auth provider, Privy signing methods, and any copy that says `Privy wallet`.
- Remove `@privy-io/node`, Privy auth verification, Privy user wallet lookup, Privy play signer, and Privy treasury signer.

---

## File Structure

**Client files to create:**
- `redline3d/src/core/auth-session.ts` - anonymous signed session auth provider.
- `redline3d/src/core/auth-session.test.ts` - client session-auth tests.
- `redline3d/src/core/solana-wallet.ts` - wallet port, target detection, dynamic loader.
- `redline3d/src/core/solana-wallet.test.ts` - loader and detection tests.
- `redline3d/src/core/wallet-standard-port.ts` - web Wallet Standard adapter.
- `redline3d/src/core/mobile-wallet-port.ts` - Seeker MWA adapter.
- `redline3d/src/core/wallet-binding.ts` - connect and bind wallet orchestration.
- `redline3d/src/core/wallet-binding.test.ts` - binding orchestration tests.

**Client files to modify:**
- `redline3d/package.json`
- `redline3d/package-lock.json`
- `redline3d/src/core/auth.ts`
- `redline3d/src/core/api.ts`
- `redline3d/src/core/api.test.ts`
- `redline3d/src/core/auth-dev.ts`
- `redline3d/src/core/play-funding.ts`
- `redline3d/src/core/play-funding.test.ts`
- `redline3d/src/main.ts`
- `redline3d/src/ui/wallet.ts`
- `redline3d/src/ui/wallet.test.ts`
- `redline3d/src/ui/auth-ui.test.ts`
- `redline3d/src/ui/controls.ts`

**Client files to delete:**
- `redline3d/src/core/auth-privy.ts`
- `redline3d/src/core/privy-island.ts`

**Server files to create:**
- `server/src/auth/session.ts` - HMAC signed anonymous session token issuer and verifier.
- `server/src/auth/session.test.ts` - session token tests.
- `server/src/auth/wallet-binding.ts` - wallet bind challenge, message, and signature verification.
- `server/src/auth/wallet-binding.test.ts` - wallet proof tests.
- `server/src/solana/fee-payer-signer.ts` - base64 wire tx partial signer for the fee-payer slot.
- `server/src/solana/fee-payer-signer.test.ts` - fee-payer signing tests.
- `server/src/services/signed-tx-broadcaster.ts` - validates signed deposit tx before RPC broadcast.
- `server/src/services/signed-tx-broadcaster.test.ts` - mutation rejection tests.

**Server files to modify:**
- `server/package.json`
- `server/package-lock.json`
- `server/src/env.ts`
- `server/src/http/auth.ts`
- `server/src/http/routes.ts`
- `server/src/http/server.ts`
- `server/src/index.ts`
- `server/src/services/users.ts`
- `server/src/services/deposit-tx.ts`
- `server/src/test/harness.ts`
- `server/src/test/auth.test.ts`
- `server/src/test/deposit-address.test.ts`
- `server/src/test/env.real-money.test.ts`
- `server/src/test/me.test.ts`

**Server files to delete:**
- `server/src/auth/privy.ts`
- `server/src/auth/privy.test.ts`
- `server/src/auth/privy-wallet.ts`
- `server/src/auth/privy-wallet.test.ts`
- `server/src/services/play-payment-charger.ts`
- `server/src/services/play-payment-charger.test.ts`
- `server/src/services/play-payment-broadcaster.ts`
- `server/src/services/play-payments.ts`
- `server/src/services/play-payments.test.ts`
- `server/src/scripts/phase0-staging.ts`
- `server/src/scripts/create-treasury.ts`
- `server/src/solana/withdraw-signer.ts`
- `server/src/solana/withdraw-signer.test.ts`

---

## Task 1: Add Wallet And Signature Dependencies

**Files:**
- Modify: `redline3d/package.json`
- Modify: `redline3d/package-lock.json`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`

**Interfaces:**
- Consumes: existing npm workspaces and package-lock files.
- Produces: installed packages for subsequent tasks, with Privy packages still present until cleanup tasks delete all imports.

- [ ] **Step 1: Add client wallet dependencies without removing Privy yet**

Edit `redline3d/package.json` dependencies to include:

```json
{
  "@solana-mobile/wallet-adapter-mobile": "2.2.9",
  "@solana/wallet-adapter-base": "0.9.27",
  "@solana/wallet-standard-wallet-adapter-base": "1.1.5",
  "@solana/web3.js": "1.98.4",
  "@wallet-standard/app": "1.1.1"
}
```

Keep `@privy-io/react-auth`, `react`, and `react-dom` in this task because `auth-privy.ts` and `privy-island.ts` still compile until Task 10.

- [ ] **Step 2: Add server signature dependencies without removing Privy yet**

Edit `server/package.json` dependencies to include:

```json
{
  "@noble/ed25519": "3.1.0",
  "bs58": "6.0.0"
}
```

Keep `@privy-io/node` in this task because `server/src/index.ts`, `server/src/auth/privy.ts`, and `server/src/solana/withdraw-signer.ts` still compile until Tasks 5 and 10.

- [ ] **Step 3: Refresh lockfiles**

Run:

```bash
cd redline3d && npm install
cd ../server && npm install
```

Expected:

```text
added packages, and audited packages
found 0 vulnerabilities
```

The exact package count can differ by npm version. The important result is exit code `0` for both installs.

- [ ] **Step 4: Verify current builds still pass**

Run:

```bash
cd redline3d && npm run build
cd ../server && npm run build
```

Expected:

```text
redline3d: vite build completes
server: tsc --noEmit completes
```

- [ ] **Step 5: Commit**

```bash
git add redline3d/package.json redline3d/package-lock.json server/package.json server/package-lock.json
git commit -m "chore: add wallet adapter migration dependencies"
```

---

## Task 2: Delete The Old Play-Payment Rail

**Files:**
- Delete: `server/src/services/play-payment-charger.ts`
- Delete: `server/src/services/play-payment-charger.test.ts`
- Delete: `server/src/services/play-payment-broadcaster.ts`
- Delete: `server/src/services/play-payments.ts`
- Delete: `server/src/services/play-payments.test.ts`
- Modify: `server/src/http/routes.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/test/harness.ts`
- Modify: `server/src/test/deposit-address.test.ts`

**Interfaces:**
- Consumes: existing `/v1/deposit/build`, `depositTxBuilder`, deposit confirmer, wallet balance reader, rounds.
- Produces: no `/v1/play/payment/*` routes and no play-payment service imports.

- [ ] **Step 1: Delete play-payment service files**

Run:

```bash
rm server/src/services/play-payment-charger.ts \
  server/src/services/play-payment-charger.test.ts \
  server/src/services/play-payment-broadcaster.ts \
  server/src/services/play-payments.ts \
  server/src/services/play-payments.test.ts
```

Expected: command exits `0`.

- [ ] **Step 2: Remove play-payment dependencies from `RouteDeps`**

In `server/src/http/routes.ts`, delete these imports:

```ts
import { createHash, randomUUID } from "node:crypto";
import { PLAY_PAYMENT_MAX_CENTS, PLAY_PAYMENT_MIN_CENTS, type PlayPaymentConfirmResult } from "../services/play-payments.js";
```

Replace them with:

```ts
import { randomUUID } from "node:crypto";
```

Then remove these `RouteDeps` fields:

```ts
  playPaymentBroadcaster: import("../services/play-payment-broadcaster.js").PlayPaymentBroadcaster | null;
  playPaymentCharger: import("../services/play-payment-charger.js").PlayPaymentCharger | null;
  playPaymentConfirmer: import("../services/play-payments.js").PlayPaymentConfirmer | null;
  payoutSigner: import("../solana/withdraw-signer.js").WithdrawSigner | null;
```

- [ ] **Step 3: Remove all `/v1/play/payment/*` route code**

In `server/src/http/routes.ts`, delete the helper functions `playPaymentRefundRef`, `refundExcessPlayPayment`, and `mapPlayPaymentChargeError`.

Delete every route whose path starts with:

```text
/v1/play/payment/
```

Keep the existing `DepositBuildBody` and `buildUserToVaultTx` helper, but reduce it to deposit-only limits:

```ts
  const DepositBuildBody = z.object({ amountCents: z.number().int().positive() });
  const buildDepositTx = async (req: any, reply: any) => {
    if (!deps.depositTxBuilder) return reply.code(404).send({ error: "deposits_disabled" });
    const body = DepositBuildBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.amountCents < deps.depositMinCents || body.data.amountCents > deps.depositMaxCents) {
      return reply.code(400).send({ error: "amount_out_of_bounds" });
    }
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    const { txBase64 } = await deps.depositTxBuilder.buildForUser(user.walletPublicKey, body.data.amountCents);
    return { txBase64 };
  };

  server.post("/v1/deposit/build", { preHandler: requireUser }, buildDepositTx);
```

- [ ] **Step 4: Remove play-payment wiring from `server/src/index.ts`**

Delete these imports:

```ts
import { PLAY_PAYMENT_MAX_CENTS, PLAY_PAYMENT_MIN_CENTS } from "./services/play-payments.js";
```

Delete these variables:

```ts
  let playPaymentBroadcaster: import("./services/play-payment-broadcaster.js").PlayPaymentBroadcaster | null = null;
  let playPaymentCharger: import("./services/play-payment-charger.js").PlayPaymentCharger | null = null;
  let playPaymentConfirmer: import("./services/play-payments.js").PlayPaymentConfirmer | null = null;
  let payoutSigner: import("./solana/withdraw-signer.js").WithdrawSigner | null = null;
```

Delete these dynamic imports from the real-money block:

```ts
    const { makeRpcPlayPaymentBroadcaster } = await import("./services/play-payment-broadcaster.js");
    const { makePlayPaymentConfirmer } = await import("./services/play-payments.js");
```

Replace the deposits range:

```ts
      minCents: PLAY_PAYMENT_MIN_CENTS, maxCents: Math.max(env.DEPOSIT_MAX_CENTS, PLAY_PAYMENT_MAX_CENTS),
```

with:

```ts
      minCents: env.DEPOSIT_MIN_CENTS, maxCents: env.DEPOSIT_MAX_CENTS,
```

Delete all `playPaymentConfirmer`, `playPaymentBroadcaster`, and `playPaymentCharger` assignments. Keep `walletBalanceReader`, `depositTxBuilder`, and withdrawals.

Remove these properties from the `buildServer` call:

```ts
    playPaymentBroadcaster,
    playPaymentCharger,
    playPaymentConfirmer,
    payoutSigner,
```

- [ ] **Step 5: Remove play-payment test harness options**

In `server/src/test/harness.ts`, remove these options from `makeTestDb`:

```ts
playPaymentBroadcaster?: import("../services/play-payment-broadcaster.js").PlayPaymentBroadcaster | null;
playPaymentCharger?: import("../services/play-payment-charger.js").PlayPaymentCharger | null;
playPaymentConfirmer?: any;
payoutSigner?: import("../solana/withdraw-signer.js").WithdrawSigner | null;
```

Remove these properties from the `buildServer` test call:

```ts
    playPaymentBroadcaster: opts.playPaymentBroadcaster ?? null,
    playPaymentCharger: opts.playPaymentCharger ?? null,
    playPaymentConfirmer: opts.playPaymentConfirmer ?? null,
    payoutSigner: opts.payoutSigner ?? null,
```

- [ ] **Step 6: Rewrite deposit route tests to deposit-only behavior**

In `server/src/test/deposit-address.test.ts`, keep tests for:

```text
GET /v1/deposit/address
GET /v1/wallet/usdc-balance
POST /v1/deposit/build
```

Delete every `describe` block for:

```text
POST /v1/play/payment/build
POST /v1/play/payment/confirm
POST /v1/play/payment/recover
POST /v1/play/payment/charge
POST /v1/play/payment/send
```

Add this regression test:

```ts
it("does not expose the old play-payment rail", async () => {
  const ctx = await makeTestDb();
  const res = await ctx.server.inject({
    method: "POST",
    url: "/v1/play/payment/build",
    headers: { "x-dev-user": "alice" },
    payload: { amountCents: 100 },
  });
  expect(res.statusCode).toBe(404);
  await ctx.close();
});
```

- [ ] **Step 7: Run server tests**

Run:

```bash
cd server && npm test
```

Expected:

```text
Test Files  ... passed
Tests       ... passed
```

- [ ] **Step 8: Commit**

```bash
git add server/src
git commit -m "refactor(server): remove play payment rail"
```

---

## Task 3: Add Anonymous Signed Session Auth

**Files:**
- Create: `server/src/auth/session.ts`
- Create: `server/src/auth/session.test.ts`
- Modify: `server/src/http/auth.ts`
- Modify: `server/src/http/routes.ts`
- Modify: `server/src/http/server.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/env.ts`
- Modify: `server/src/test/harness.ts`
- Modify: `server/src/test/auth.test.ts`
- Modify: `server/src/test/me.test.ts`

**Interfaces:**
- Consumes: `Users.upsertByExternalId(externalId: string)`.
- Produces: `SessionAuth` with `issueAnonymous(): Promise<{ token: string; userId: string }>` and `verifyToken(token: string): Promise<string | null>`.

- [ ] **Step 1: Write `server/src/auth/session.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { makeSessionAuth } from "./session.js";

describe("makeSessionAuth", () => {
  const users = {
    async upsertByExternalId(externalId: string) {
      return { id: `user-for-${externalId}`, externalId, walletPublicKey: null } as any;
    },
  };

  it("issues and verifies an anonymous session token", async () => {
    const auth = makeSessionAuth({ users: users as any, secret: "s".repeat(32), now: () => 1000 });
    const issued = await auth.issueAnonymous();
    expect(issued.token.startsWith("v1.")).toBe(true);
    await expect(auth.verifyToken(issued.token)).resolves.toBe(issued.userId);
  });

  it("rejects a token whose payload was modified", async () => {
    const auth = makeSessionAuth({ users: users as any, secret: "s".repeat(32), now: () => 1000 });
    const issued = await auth.issueAnonymous();
    const parts = issued.token.split(".");
    const tampered = `${parts[0]}.${parts[1].replace(/.$/, parts[1].endsWith("a") ? "b" : "a")}.${parts[2]}`;
    await expect(auth.verifyToken(tampered)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    let now = 1000;
    const auth = makeSessionAuth({ users: users as any, secret: "s".repeat(32), now: () => now, ttlMs: 10 });
    const issued = await auth.issueAnonymous();
    now = 1011;
    await expect(auth.verifyToken(issued.token)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd server && npx vitest run src/auth/session.test.ts
```

Expected:

```text
FAIL  src/auth/session.test.ts
Cannot find module './session.js'
```

- [ ] **Step 3: Create `server/src/auth/session.ts`**

```ts
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Users } from "../services/users.js";

export interface SessionAuth {
  issueAnonymous(): Promise<{ token: string; userId: string }>;
  verifyToken(token: string): Promise<string | null>;
}

export interface SessionAuthDeps {
  users: Users;
  secret: string;
  now?: () => number;
  ttlMs?: number;
}

const enc = new TextEncoder();
const b64url = (buf: Uint8Array | string) =>
  Buffer.from(typeof buf === "string" ? enc.encode(buf) : buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeSessionAuth(deps: SessionAuthDeps): SessionAuth {
  if (deps.secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 1000 * 60 * 60 * 24 * 30;
  return {
    async issueAnonymous() {
      const user = await deps.users.upsertByExternalId(`anon:${randomUUID()}`);
      const payload = b64url(JSON.stringify({ sub: user.id, exp: now() + ttlMs }));
      return { token: `v1.${payload}.${sign(deps.secret, payload)}`, userId: user.id };
    },
    async verifyToken(token) {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "v1") return null;
      const expected = sign(deps.secret, parts[1]);
      const a = Buffer.from(parts[2]);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      let payload: { sub?: string; exp?: number };
      try { payload = JSON.parse(fromB64url(parts[1])); }
      catch { return null; }
      if (!payload.sub || typeof payload.exp !== "number" || payload.exp <= now()) return null;
      return payload.sub;
    },
  };
}
```

- [ ] **Step 4: Replace Privy request auth with session request auth**

In `server/src/http/auth.ts`, replace the file with:

```ts
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Users } from "../services/users.js";
import type { SessionAuth } from "../auth/session.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

const DEV_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface RequireUserDeps {
  users: Users;
  devAuth: boolean;
  sessionAuth: SessionAuth;
}

export function makeRequireUser(deps: RequireUserDeps) {
  return async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (bearer) {
      const userId = await deps.sessionAuth.verifyToken(bearer);
      if (!userId) { await reply.code(401).send({ error: "invalid_token" }); return; }
      req.userId = userId;
      return;
    }

    if (deps.devAuth) {
      const dev = req.headers["x-dev-user"];
      const name = Array.isArray(dev) ? dev[0] : dev;
      if (name && DEV_NAME_RE.test(name)) {
        req.userId = (await deps.users.upsertByExternalId(`dev:${name}`)).id;
        return;
      }
    }

    await reply.code(401).send({ error: "unauthorized" });
  };
}
```

- [ ] **Step 5: Add session auth to `RouteDeps` and expose `POST /v1/session`**

In `server/src/http/routes.ts`, replace the `privyAuth` field with:

```ts
  sessionAuth: import("../auth/session.js").SessionAuth;
```

Create the route before any authenticated routes:

```ts
  server.post("/v1/session", async () => deps.sessionAuth.issueAnonymous());
```

Replace:

```ts
  const requireUser = makeRequireUser({ users: deps.users, devAuth: deps.devAuth, privyAuth: deps.privyAuth });
```

with:

```ts
  const requireUser = makeRequireUser({ users: deps.users, devAuth: deps.devAuth, sessionAuth: deps.sessionAuth });
```

- [ ] **Step 6: Update CORS allowed headers**

In `server/src/http/server.ts`, replace:

```ts
allowedHeaders: ["x-dev-user", "x-privy-wallet", "content-type", "authorization"],
```

with:

```ts
allowedHeaders: ["x-dev-user", "content-type", "authorization"],
```

- [ ] **Step 7: Add env config and production guard**

In `server/src/env.ts`, add:

```ts
  SESSION_SECRET: z.string().min(32).optional(),
```

In the `superRefine`, add:

```ts
  if (e.NODE_ENV === "production" && !e.SESSION_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SESSION_SECRET"],
      message: "SESSION_SECRET is required in production",
    });
  }
```

- [ ] **Step 8: Wire session auth in `server/src/index.ts`**

Delete:

```ts
import { makePrivyAuth } from "./auth/privy.js";
```

Add:

```ts
import { makeSessionAuth } from "./auth/session.js";
```

Replace the Privy production guard:

```ts
  const privyAuth = makePrivyAuth(env);
  if (env.NODE_ENV === "production" && !privyAuth)
    throw new Error(
      "FATAL: production requires Privy keys (PRIVY_APP_ID/PRIVY_APP_SECRET) - refusing to start with auth disabled",
    );
```

with:

```ts
  const sessionAuth = makeSessionAuth({
    users,
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
  });
```

Replace `privyAuth,` in the `buildServer` call with:

```ts
    sessionAuth,
```

- [ ] **Step 9: Update test harness**

In `server/src/test/harness.ts`, import session auth:

```ts
import { makeSessionAuth, type SessionAuth } from "../auth/session.js";
```

Replace the `privyAuth` option with:

```ts
sessionAuth?: SessionAuth;
```

In the `buildServer` call, replace:

```ts
    privyAuth: opts.privyAuth ?? null,
```

with:

```ts
    sessionAuth: opts.sessionAuth ?? makeSessionAuth({
      users,
      secret: "test-session-secret-32-characters-long",
    }),
```

- [ ] **Step 10: Rewrite auth tests**

In `server/src/test/auth.test.ts`, remove fake Privy helpers and replace Bearer tests with:

```ts
it("valid session Bearer resolves the session user", async () => {
  const sessionAuth = makeSessionAuth({ users: ctx.users, secret: "test-session-secret-32-characters-long" });
  const issued = await sessionAuth.issueAnonymous();
  const a = app({ sessionAuth });
  const r = await a.inject({ method: "GET", url: "/who", headers: { authorization: `Bearer ${issued.token}` } });
  expect(r.statusCode).toBe(200);
  expect(r.json().userId).toBe(issued.userId);
  await a.close();
});

it("invalid Bearer does not fall through to dev auth", async () => {
  const a = app({ devAuth: true });
  const r = await a.inject({
    method: "GET",
    url: "/who",
    headers: { authorization: "Bearer invalid", "x-dev-user": "alice" },
  });
  expect(r.statusCode).toBe(401);
  expect(r.json().error).toBe("invalid_token");
  await a.close();
});
```

The local `app` helper must call:

```ts
const requireUser = makeRequireUser({
  users: ctx.users,
  devAuth: opts.devAuth ?? true,
  sessionAuth: opts.sessionAuth ?? makeSessionAuth({
    users: ctx.users,
    secret: "test-session-secret-32-characters-long",
  }),
});
```

- [ ] **Step 11: Run server auth tests**

Run:

```bash
cd server && npx vitest run src/auth/session.test.ts src/test/auth.test.ts src/test/me.test.ts
```

Expected:

```text
Test Files  3 passed
Tests       ... passed
```

- [ ] **Step 12: Commit**

```bash
git add server/src
git commit -m "feat(server): add anonymous session auth"
```

---

## Task 4: Add Signed Wallet Binding On The Server

**Files:**
- Create: `server/src/auth/wallet-binding.ts`
- Create: `server/src/auth/wallet-binding.test.ts`
- Modify: `server/src/http/routes.ts`
- Modify: `server/src/services/users.ts`
- Modify: `server/src/test/deposit-address.test.ts`

**Interfaces:**
- Consumes: `req.userId`, `Users.setWalletPublicKey(id: string, address: string)`.
- Produces: `POST /v1/wallet/bind-challenge` and `POST /v1/wallet/bind`.

- [ ] **Step 1: Add wallet binding tests**

Create `server/src/auth/wallet-binding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { createWalletBinding } from "./wallet-binding.js";

describe("createWalletBinding", () => {
  it("verifies the wallet signature for the challenge message", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    const wallet = bs58.encode(publicKey);
    const binding = createWalletBinding({ secret: "b".repeat(32), now: () => 1000 });
    const challenge = binding.createChallenge({ userId: "user-1", wallet });
    const signatureBase58 = bs58.encode(await ed.signAsync(new TextEncoder().encode(challenge.message), secretKey));

    const verified = await binding.verifyChallenge({ challenge: challenge.challenge, signatureBase58 });

    expect(verified).toEqual({ userId: "user-1", wallet });
  });

  it("rejects a signature from another wallet", async () => {
    const secretA = ed.utils.randomSecretKey();
    const secretB = ed.utils.randomSecretKey();
    const wallet = bs58.encode(await ed.getPublicKeyAsync(secretA));
    const binding = createWalletBinding({ secret: "b".repeat(32), now: () => 1000 });
    const challenge = binding.createChallenge({ userId: "user-1", wallet });
    const signatureBase58 = bs58.encode(await ed.signAsync(new TextEncoder().encode(challenge.message), secretB));

    await expect(binding.verifyChallenge({ challenge: challenge.challenge, signatureBase58 })).resolves.toBeNull();
  });

  it("rejects an expired challenge", async () => {
    let now = 1000;
    const secretKey = ed.utils.randomSecretKey();
    const wallet = bs58.encode(await ed.getPublicKeyAsync(secretKey));
    const binding = createWalletBinding({ secret: "b".repeat(32), now: () => now, ttlMs: 10 });
    const challenge = binding.createChallenge({ userId: "user-1", wallet });
    const signatureBase58 = bs58.encode(await ed.signAsync(new TextEncoder().encode(challenge.message), secretKey));
    now = 1011;

    await expect(binding.verifyChallenge({ challenge: challenge.challenge, signatureBase58 })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd server && npx vitest run src/auth/wallet-binding.test.ts
```

Expected:

```text
FAIL  src/auth/wallet-binding.test.ts
Cannot find module './wallet-binding.js'
```

- [ ] **Step 3: Create `server/src/auth/wallet-binding.ts`**

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { verifyAsync } from "@noble/ed25519";

const enc = new TextEncoder();
const b64url = (buf: Uint8Array | string) =>
  Buffer.from(typeof buf === "string" ? enc.encode(buf) : buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface WalletBinding {
  createChallenge(input: { userId: string; wallet: string }): { challenge: string; message: string; wallet: string; expiresAt: string };
  verifyChallenge(input: { challenge: string; signatureBase58: string }): Promise<{ userId: string; wallet: string } | null>;
}

export function createWalletBinding(deps: { secret: string; now?: () => number; ttlMs?: number }): WalletBinding {
  if (deps.secret.length < 32) throw new Error("wallet binding secret must be at least 32 characters");
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 5 * 60 * 1000;
  const sign = (payload: string) => createHmac("sha256", deps.secret).update(payload).digest("base64url");
  const messageFor = (p: { userId: string; wallet: string; nonce: string; exp: number }) =>
    [
      "Redline wallet binding",
      `Wallet: ${p.wallet}`,
      `Session: ${p.userId}`,
      `Nonce: ${p.nonce}`,
      `Expires: ${new Date(p.exp).toISOString()}`,
    ].join("\n");

  return {
    createChallenge({ userId, wallet }) {
      if (!SOLANA_ADDRESS_RE.test(wallet)) throw new Error("invalid_wallet_address");
      const payloadObj = { userId, wallet, nonce: randomBytes(16).toString("hex"), exp: now() + ttlMs };
      const message = messageFor(payloadObj);
      const payload = b64url(JSON.stringify({ ...payloadObj, message }));
      return {
        challenge: `v1.${payload}.${sign(payload)}`,
        message,
        wallet,
        expiresAt: new Date(payloadObj.exp).toISOString(),
      };
    },
    async verifyChallenge({ challenge, signatureBase58 }) {
      const parts = challenge.split(".");
      if (parts.length !== 3 || parts[0] !== "v1") return null;
      const expected = sign(parts[1]);
      const a = Buffer.from(parts[2]);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      let payload: { userId?: string; wallet?: string; exp?: number; message?: string };
      try { payload = JSON.parse(fromB64url(parts[1])); }
      catch { return null; }
      if (!payload.userId || !payload.wallet || !payload.message || typeof payload.exp !== "number") return null;
      if (payload.exp <= now() || !SOLANA_ADDRESS_RE.test(payload.wallet)) return null;
      let signature: Uint8Array;
      let publicKey: Uint8Array;
      try {
        signature = bs58.decode(signatureBase58);
        publicKey = bs58.decode(payload.wallet);
      } catch {
        return null;
      }
      if (signature.length !== 64 || publicKey.length !== 32) return null;
      const ok = await verifyAsync(signature, enc.encode(payload.message), publicKey);
      return ok ? { userId: payload.userId, wallet: payload.wallet } : null;
    },
  };
}
```

- [ ] **Step 4: Add wallet binding to `RouteDeps` and routes**

In `server/src/http/routes.ts`, add to `RouteDeps`:

```ts
  walletBinding: import("../auth/wallet-binding.js").WalletBinding;
```

Add schemas near other route schemas:

```ts
const WalletBindChallengeBody = z.object({ wallet: z.string().min(32).max(44) });
const WalletBindBody = z.object({
  challenge: z.string().min(1),
  signatureBase58: z.string().min(1),
});
```

Add routes before `GET /v1/wallet/usdc-balance`:

```ts
  server.post("/v1/wallet/bind-challenge", { preHandler: requireUser }, async (req, reply) => {
    const body = WalletBindChallengeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      return deps.walletBinding.createChallenge({ userId: req.userId!, wallet: body.data.wallet });
    } catch {
      return reply.code(400).send({ error: "invalid_wallet_address" });
    }
  });

  server.post("/v1/wallet/bind", { preHandler: requireUser }, async (req, reply) => {
    const body = WalletBindBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const verified = await deps.walletBinding.verifyChallenge(body.data);
    if (!verified || verified.userId !== req.userId!) return reply.code(401).send({ error: "invalid_wallet_signature" });
    const user = await deps.users.setWalletPublicKey(req.userId!, verified.wallet);
    return { wallet: user.walletPublicKey };
  });
```

- [ ] **Step 5: Add uniqueness guard in users service**

In `server/src/services/users.ts`, import:

```ts
import { eq, and, isNull, ne } from "drizzle-orm";
```

Before updating the current user in `setWalletPublicKey`, add:

```ts
      const owner = await db
        .select()
        .from(users)
        .where(and(eq(users.walletPublicKey, address), ne(users.id, id)))
        .limit(1);
      if (owner[0]) throw new Error("wallet_already_bound");
```

In the `/v1/wallet/bind` route, wrap the call and return conflict:

```ts
    try {
      const user = await deps.users.setWalletPublicKey(req.userId!, verified.wallet);
      return { wallet: user.walletPublicKey };
    } catch (e) {
      if (e instanceof Error && e.message === "wallet_already_bound") {
        return reply.code(409).send({ error: "wallet_already_bound" });
      }
      throw e;
    }
```

- [ ] **Step 6: Wire binding in production and tests**

In `server/src/index.ts`, import:

```ts
import { createWalletBinding } from "./auth/wallet-binding.js";
```

Create:

```ts
  const walletBinding = createWalletBinding({
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
  });
```

Pass `walletBinding` to `buildServer`.

In `server/src/test/harness.ts`, add an optional `walletBinding` test option and default:

```ts
walletBinding?: import("../auth/wallet-binding.js").WalletBinding;
```

Use:

```ts
walletBinding: opts.walletBinding ?? createWalletBinding({ secret: "test-wallet-binding-secret-32-chars" }),
```

- [ ] **Step 7: Add route-level tests**

In `server/src/test/deposit-address.test.ts`, add:

```ts
it("binds a wallet only after a valid wallet signature", async () => {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  const wallet = bs58.encode(publicKey);
  const ctx = await makeTestDb();
  const headers = { "x-dev-user": "alice" };
  const c = await ctx.server.inject({ method: "POST", url: "/v1/wallet/bind-challenge", headers, payload: { wallet } });
  expect(c.statusCode).toBe(200);
  const signatureBase58 = bs58.encode(await ed.signAsync(new TextEncoder().encode(c.json().message), secretKey));
  const b = await ctx.server.inject({
    method: "POST",
    url: "/v1/wallet/bind",
    headers,
    payload: { challenge: c.json().challenge, signatureBase58 },
  });
  expect(b.statusCode).toBe(200);
  expect(b.json()).toEqual({ wallet });
  await ctx.close();
});
```

Add imports at the top:

```ts
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
```

- [ ] **Step 8: Run binding tests**

Run:

```bash
cd server && npx vitest run src/auth/wallet-binding.test.ts src/test/deposit-address.test.ts
```

Expected:

```text
Test Files  2 passed
Tests       ... passed
```

- [ ] **Step 9: Commit**

```bash
git add server/src
git commit -m "feat(server): add signed wallet binding"
```

---

## Task 5: Replace Privy Fee-Payer Signing

**Files:**
- Create: `server/src/solana/fee-payer-signer.ts`
- Create: `server/src/solana/fee-payer-signer.test.ts`
- Create: `server/src/services/signed-tx-broadcaster.ts`
- Create: `server/src/services/signed-tx-broadcaster.test.ts`
- Modify: `server/src/env.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/services/deposit-tx.ts`
- Modify: `server/src/services/deposit-tx.test.ts`
- Modify: `server/src/http/routes.ts`
- Modify: `server/src/test/harness.ts`

**Interfaces:**
- Consumes: base64 wire transaction from `depositTxBuilder`.
- Produces: `makeFeePayerSigner(secret).signFeePayerTx(txBase64): Promise<string>` that signs only the configured fee-payer slot.

- [ ] **Step 1: Create failing fee-payer signer tests**

Create `server/src/solana/fee-payer-signer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  address,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { makeFeePayerSignerFromKeyPair } from "./fee-payer-signer.js";

describe("makeFeePayerSignerFromKeyPair", () => {
  it("signs only the fee-payer slot and leaves user authority unsigned", async () => {
    const feePayer = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const ix = getTransferCheckedInstruction({
      source: address("11111111111111111111111111111112"),
      mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      destination: address("11111111111111111111111111111113"),
      authority: createNoopSigner(authority.address),
      amount: 100n,
      decimals: 6,
    });
    const txBase64 = getBase64EncodedWireTransaction(compileTransaction(pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({
        blockhash: "11111111111111111111111111111111" as never,
        lastValidBlockHeight: 10n,
      }, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    )));

    const signed = await makeFeePayerSignerFromKeyPair(feePayer.keyPair).signFeePayerTx(txBase64);
    const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(signed));

    expect(decoded.signatures[feePayer.address]).not.toBeNull();
    expect(decoded.signatures[authority.address]).toBeNull();
  });
});
```

- [ ] **Step 2: Create `server/src/solana/fee-payer-signer.ts`**

```ts
import {
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";

export interface FeePayerSigner {
  signFeePayerTx(txBase64: string): Promise<string>;
}

export function parseFeePayerSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return Uint8Array.from(parsed);
  }
  return Buffer.from(trimmed, "base64");
}

export function makeFeePayerSignerFromKeyPair(keyPair: CryptoKeyPair): FeePayerSigner {
  return {
    async signFeePayerTx(txBase64) {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(txBase64));
      const signed = await partiallySignTransaction([keyPair], tx);
      return getBase64EncodedWireTransaction(signed);
    },
  };
}

export async function makeFeePayerSigner(secret: string): Promise<FeePayerSigner & { address: string }> {
  const signer = await createKeyPairSignerFromBytes(parseFeePayerSecret(secret), false);
  return {
    address: signer.address,
    ...makeFeePayerSignerFromKeyPair(signer.keyPair),
  };
}
```

- [ ] **Step 3: Update deposit tx comments**

In `server/src/services/deposit-tx.ts`, replace comments that mention Privy with:

```ts
   * Optional sponsorship path. When set, the server builds the deposit tx with the
   * configured fee-payer owner and pre-signs only that fee-payer slot, then
   * returns the partially signed tx for the user's wallet to sign as source authority.
```

- [ ] **Step 4: Add fee-payer env**

In `server/src/env.ts`, add:

```ts
  FEE_PAYER_SECRET: z.string().min(1).optional(),
  FEE_PAYER_OWNER_PUBKEY: z.string().min(32).optional(),
```

In real-money `superRefine`, add:

```ts
  if (!!e.FEE_PAYER_SECRET !== !!e.FEE_PAYER_OWNER_PUBKEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["FEE_PAYER_SECRET"],
      message: "FEE_PAYER_SECRET and FEE_PAYER_OWNER_PUBKEY must be set together",
    });
  }
```

- [ ] **Step 5: Wire fee-payer signer in `server/src/index.ts`**

Inside the real-money block, delete all `privyClient`, `TREASURY_WALLET_ID`, `TREASURY_OWNER_PUBKEY`, and `makePrivyWithdrawSigner` code.

Replace it with:

```ts
    let signFeePayerTx: ((txBase64: string) => Promise<string>) | undefined;
    let feePayerOwner = env.FEE_PAYER_OWNER_PUBKEY;
    if (env.FEE_PAYER_SECRET && env.FEE_PAYER_OWNER_PUBKEY) {
      const { makeFeePayerSigner } = await import("./solana/fee-payer-signer.js");
      const signer = await makeFeePayerSigner(env.FEE_PAYER_SECRET);
      if (signer.address !== env.FEE_PAYER_OWNER_PUBKEY) {
        throw new Error("FEE_PAYER_OWNER_PUBKEY does not match FEE_PAYER_SECRET");
      }
      if (env.TREASURY_OWNER_PUBKEY && env.FEE_PAYER_OWNER_PUBKEY === env.TREASURY_OWNER_PUBKEY) {
        throw new Error("fee payer must not be the treasury token authority");
      }
      signFeePayerTx = signer.signFeePayerTx;
    } else {
      feePayerOwner = undefined;
      console.warn("[fee_payer_disabled] falling back to user-paid Solana fees");
    }
```

Then pass:

```ts
      treasuryOwner: signFeePayerTx ? feePayerOwner : undefined,
      signFeePayerTx,
```

to `makeDepositTxBuilder`.

- [ ] **Step 6: Add signed tx broadcast service**

Create `server/src/services/signed-tx-broadcaster.ts`:

```ts
import {
  assertIsFullySignedTransaction,
  createSolanaRpc,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from "@solana/kit";

export interface SignedTxBroadcaster {
  broadcastSignedDeposit(input: { expectedTxBase64: string; signedTxBase64: string }): Promise<{ txSig: string }>;
}

export function makeSignedTxBroadcaster(sendTransaction: (txBase64: string) => Promise<string>): SignedTxBroadcaster {
  return {
    async broadcastSignedDeposit({ expectedTxBase64, signedTxBase64 }) {
      const expected = getTransactionDecoder().decode(getBase64Encoder().encode(expectedTxBase64));
      const signed = getTransactionDecoder().decode(getBase64Encoder().encode(signedTxBase64));
      if (Buffer.compare(Buffer.from(expected.messageBytes), Buffer.from(signed.messageBytes)) !== 0) {
        throw new Error("signed_transaction_message_mismatch");
      }
      for (const address of Object.keys(expected.signatures)) {
        if (expected.signatures[address] && !signed.signatures[address]) {
          throw new Error("signed_transaction_missing_existing_signature");
        }
      }
      assertIsFullySignedTransaction(signed);
      const txSig = await sendTransaction(getBase64EncodedWireTransaction(signed));
      return { txSig };
    },
  };
}

export function makeRpcSignedTxBroadcaster(rpcUrl: string): SignedTxBroadcaster {
  const rpc = createSolanaRpc(rpcUrl);
  return makeSignedTxBroadcaster((txBase64) => rpc.sendTransaction(txBase64, { encoding: "base64" }).send());
}
```

- [ ] **Step 7: Add signed tx broadcast tests**

Create `server/src/services/signed-tx-broadcaster.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { makeSignedTxBroadcaster } from "./signed-tx-broadcaster.js";

async function fixture(amount: bigint) {
  const feePayer = await generateKeyPairSigner();
  const authority = await generateKeyPairSigner();
  const ix = getTransferCheckedInstruction({
    source: address("11111111111111111111111111111112"),
    mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    destination: address("11111111111111111111111111111113"),
    authority: createNoopSigner(authority.address),
    amount,
    decimals: 6,
  });
  const unsigned = compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({
      blockhash: "11111111111111111111111111111111" as never,
      lastValidBlockHeight: 10n,
    }, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  ));
  const signed = await partiallySignTransaction([feePayer.keyPair, authority.keyPair], unsigned);
  return {
    expectedTxBase64: getBase64EncodedWireTransaction(unsigned),
    signedTxBase64: getBase64EncodedWireTransaction(signed),
  };
}

describe("makeSignedTxBroadcaster", () => {
  it("broadcasts a fully signed transaction whose message matches the server-built transaction", async () => {
    const send = vi.fn(async () => "sig-123");
    const tx = await fixture(100n);

    const out = await makeSignedTxBroadcaster(send).broadcastSignedDeposit(tx);

    expect(out).toEqual({ txSig: "sig-123" });
    expect(send).toHaveBeenCalledWith(tx.signedTxBase64);
  });

  it("rejects a signed transaction whose message was mutated", async () => {
    const send = vi.fn(async () => "sig-123");
    const expected = await fixture(100n);
    const mutated = await fixture(200n);

    await expect(makeSignedTxBroadcaster(send).broadcastSignedDeposit({
      expectedTxBase64: expected.expectedTxBase64,
      signedTxBase64: mutated.signedTxBase64,
    })).rejects.toThrow("signed_transaction_message_mismatch");
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Expose signed deposit broadcast route**

In `server/src/http/routes.ts`, add to `RouteDeps`:

```ts
  signedTxBroadcaster: import("../services/signed-tx-broadcaster.js").SignedTxBroadcaster | null;
```

Add schema:

```ts
const DepositSendBody = z.object({
  expectedTxBase64: z.string().min(1),
  signedTxBase64: z.string().min(1),
});
```

Add route:

```ts
  server.post("/v1/deposit/send", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.signedTxBroadcaster) return reply.code(404).send({ error: "deposit_send_disabled" });
    const body = DepositSendBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      return await deps.signedTxBroadcaster.broadcastSignedDeposit(body.data);
    } catch (e) {
      if (e instanceof Error && e.message === "signed_transaction_message_mismatch") {
        return reply.code(400).send({ error: "signed_transaction_message_mismatch" });
      }
      throw e;
    }
  });
```

Wire `signedTxBroadcaster` in `server/src/index.ts` when real money is enabled:

```ts
    const { makeRpcSignedTxBroadcaster } = await import("./services/signed-tx-broadcaster.js");
    signedTxBroadcaster = makeRpcSignedTxBroadcaster(env.SOLANA_RPC_URL!);
```

Declare it before the real-money block as:

```ts
  let signedTxBroadcaster: import("./services/signed-tx-broadcaster.js").SignedTxBroadcaster | null = null;
```

Pass it to `buildServer`.

- [ ] **Step 9: Run signer and deposit tests**

Run:

```bash
cd server && npx vitest run src/solana/fee-payer-signer.test.ts src/services/deposit-tx.test.ts src/services/signed-tx-broadcaster.test.ts src/test/deposit-address.test.ts
```

Expected:

```text
Test Files  4 passed
Tests       ... passed
```

- [ ] **Step 10: Commit**

```bash
git add server/src
git commit -m "feat(server): replace privy fee payer signing"
```

---

## Task 6: Add Client Session Auth

**Files:**
- Create: `redline3d/src/core/auth-session.ts`
- Create: `redline3d/src/core/auth-session.test.ts`
- Modify: `redline3d/src/core/auth.ts`
- Modify: `redline3d/src/core/api.ts`
- Modify: `redline3d/src/core/auth-dev.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: `POST /v1/session` server endpoint.
- Produces: `createSessionAuth(opts?: { baseUrl?: string; fetch?: typeof fetch; storage?: Storage }): AuthProvider`.

- [ ] **Step 1: Simplify `AuthProvider`**

Replace `redline3d/src/core/auth.ts` with:

```ts
export interface AuthProvider {
  ready(): Promise<void>;
  userId(): string;
  authHeaders(): Promise<Record<string, string>>;
  logout?(): Promise<void>;
}
```

- [ ] **Step 2: Add session-auth tests**

Create `redline3d/src/core/auth-session.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSessionAuth } from "./auth-session";

describe("createSessionAuth", () => {
  it("creates an anonymous session when no token is stored", async () => {
    const store = new Map<string, string>();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ token: "tok", userId: "u1" }), { status: 200 }));
    const auth = createSessionAuth({
      baseUrl: "http://api",
      fetch: fetch as any,
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) } as Storage,
    });
    await auth.ready();
    expect(await auth.authHeaders()).toEqual({ authorization: "Bearer tok" });
    expect(auth.userId()).toBe("u1");
    expect(fetch).toHaveBeenCalledWith("http://api/v1/session", { method: "POST" });
  });

  it("reuses a stored session without calling fetch", async () => {
    const fetch = vi.fn();
    const auth = createSessionAuth({
      baseUrl: "http://api",
      fetch: fetch as any,
      storage: {
        getItem: (k) => k.endsWith(":token") ? "stored-token" : "stored-user",
        setItem: () => {},
        removeItem: () => {},
      } as any,
    });
    await auth.ready();
    expect(await auth.authHeaders()).toEqual({ authorization: "Bearer stored-token" });
    expect(auth.userId()).toBe("stored-user");
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Create `redline3d/src/core/auth-session.ts`**

```ts
import type { AuthProvider } from "./auth";

export interface SessionAuthOpts {
  baseUrl?: string;
  fetch?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const TOKEN_KEY = "redline.session:token";
const USER_KEY = "redline.session:user";

export function createSessionAuth(opts: SessionAuthOpts = {}): AuthProvider {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (opts.baseUrl ?? (import.meta.env?.VITE_API_BASE as string) ?? "http://localhost:8080").replace(/\/$/, "");
  const storage = opts.storage ?? localStorage;
  let token = storage.getItem(TOKEN_KEY);
  let uid = storage.getItem(USER_KEY) ?? "";
  let init: Promise<void> | null = null;

  async function ensure() {
    if (token && uid) return;
    const res = await doFetch(`${baseUrl}/v1/session`, { method: "POST" });
    if (!res.ok) throw new Error("session_create_failed");
    const body = await res.json() as { token: string; userId: string };
    token = body.token;
    uid = body.userId;
    storage.setItem(TOKEN_KEY, token);
    storage.setItem(USER_KEY, uid);
  }

  return {
    ready() {
      init ??= ensure();
      return init;
    },
    userId() {
      return uid;
    },
    async authHeaders() {
      await (init ??= ensure());
      return { authorization: `Bearer ${token}` };
    },
    async logout() {
      storage.removeItem(TOKEN_KEY);
      storage.removeItem(USER_KEY);
      token = null;
      uid = "";
      init = null;
    },
  };
}
```

- [ ] **Step 4: Update `auth-dev.ts` to match the smaller interface**

Keep `ready`, `userId`, `authHeaders`, and `logout` only. Delete all signing methods and wallet public key methods.

The returned object should be:

```ts
export function createDevAuth(): AuthProvider {
  const user = getDevUserId();
  return {
    async ready() {},
    userId: () => user,
    async authHeaders() { return { "x-dev-user": user }; },
    async logout() {},
  };
}
```

- [ ] **Step 5: Update API types**

In `redline3d/src/core/api.ts`, add:

```ts
  bindWalletChallenge(wallet: string): Promise<{ challenge: string; message: string; wallet: string; expiresAt: string }>;
  bindWallet(input: { challenge: string; signatureBase58: string }): Promise<{ wallet: string }>;
  depositSend(input: { expectedTxBase64: string; signedTxBase64: string }): Promise<{ txSig: string }>;
```

Add implementations:

```ts
    bindWalletChallenge: (wallet) => call("POST", "/v1/wallet/bind-challenge", { wallet }),
    bindWallet: (input) => call("POST", "/v1/wallet/bind", input),
    depositSend: (input) => call("POST", "/v1/deposit/send", input),
```

Update comments that mention `Privy wallet` to say `connected wallet`.

- [ ] **Step 6: Use session auth in `main.ts`**

Replace:

```ts
import { createPrivyAuth } from "./core/auth-privy";
```

with:

```ts
import { createSessionAuth } from "./core/auth-session";
```

Replace the auth selection:

```ts
const usePrivy = (import.meta.env?.VITE_AUTH as string) === "privy";
const auth: AuthProvider = usePrivy
  ? createPrivyAuth(import.meta.env.VITE_PRIVY_APP_ID as string)
  : createDevAuth();
```

with:

```ts
const useDevAuth = (import.meta.env?.VITE_AUTH as string) === "dev";
const auth: AuthProvider = useDevAuth ? createDevAuth() : createSessionAuth();
```

Replace:

```ts
function triggerSignIn() { if (auth.login) auth.login(); }
```

with:

```ts
function triggerSignIn() { void initSession(); }
```

Remove Privy storage and cookie cleanup from `doLogout`. The new body is:

```ts
async function doLogout() {
  signedIn = false;
  serverMark = null;
  try { await auth.logout?.(); } catch {}
  location.reload();
}
```

- [ ] **Step 7: Run client auth tests**

Run:

```bash
cd redline3d && npx vitest run src/core/auth-session.test.ts src/core/auth.test.ts src/core/api.test.ts
```

Expected:

```text
Test Files  3 passed
Tests       ... passed
```

- [ ] **Step 8: Commit**

```bash
git add redline3d/src/core redline3d/src/main.ts
git commit -m "feat(client): add anonymous session auth"
```

---

## Task 7: Add Wallet Port, Web Adapter, And Seeker Adapter

**Files:**
- Create: `redline3d/src/core/solana-wallet.ts`
- Create: `redline3d/src/core/solana-wallet.test.ts`
- Create: `redline3d/src/core/wallet-standard-port.ts`
- Create: `redline3d/src/core/mobile-wallet-port.ts`

**Interfaces:**
- Produces:

```ts
export interface SolanaWalletPort {
  kind: "web-standard" | "mobile-wallet-adapter";
  connect(): Promise<{ address: string; label?: string }>;
  disconnect(): Promise<void>;
  currentAddress(): string | null;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(txBase64: string): Promise<string>;
  signAndSendTransaction?(txBase64: string): Promise<string>;
}
```

- [ ] **Step 1: Add loader tests**

Create `redline3d/src/core/solana-wallet.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

describe("wallet target detection", () => {
  it("chooses seeker for capacitor android user agent", async () => {
    const { chooseWalletTarget } = await import("./solana-wallet");
    expect(chooseWalletTarget("auto", { userAgent: "Mozilla/5.0 Android Seeker", capacitorNative: true })).toBe("seeker");
  });

  it("chooses web for ordinary browser", async () => {
    const { chooseWalletTarget } = await import("./solana-wallet");
    expect(chooseWalletTarget("auto", { userAgent: "Mozilla/5.0 Mac OS X", capacitorNative: false })).toBe("web");
  });
});
```

- [ ] **Step 2: Create `redline3d/src/core/solana-wallet.ts`**

```ts
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
  const cap = (globalThis as any).Capacitor;
  return {
    userAgent: navigator.userAgent,
    capacitorNative: !!cap?.isNativePlatform?.(),
  };
}

export function chooseWalletTarget(target: WalletTarget, info = runtimeInfo()): ResolvedWalletTarget {
  if (target === "web" || target === "seeker") return target;
  if (info.capacitorNative && /Android/i.test(info.userAgent)) return "seeker";
  if (/Seeker/i.test(info.userAgent)) return "seeker";
  return "web";
}

export async function loadSolanaWalletPort(target: WalletTarget = "auto"): Promise<SolanaWalletPort> {
  const resolved = chooseWalletTarget(target);
  if (resolved === "seeker") {
    const { createMobileWalletPort } = await import("./mobile-wallet-port");
    return createMobileWalletPort();
  }
  const { createWalletStandardPort } = await import("./wallet-standard-port");
  return createWalletStandardPort();
}
```

- [ ] **Step 3: Create web Wallet Standard port**

Create `redline3d/src/core/wallet-standard-port.ts`:

```ts
import { getWallets } from "@wallet-standard/app";
import { StandardWalletAdapter } from "@solana/wallet-standard-wallet-adapter-base";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { WalletAdapterCompatibleStandardWallet } from "@solana/wallet-adapter-base";
import type { SolanaWalletPort } from "./solana-wallet";

const RPC_URL = (import.meta.env?.VITE_SOLANA_RPC_URL as string) ?? "https://api.mainnet-beta.solana.com";

function pickWallet(): WalletAdapterCompatibleStandardWallet {
  const wallets = getWallets().get() as readonly WalletAdapterCompatibleStandardWallet[];
  const candidates = wallets.filter((w) => w.chains.includes("solana:mainnet" as any) || w.chains.includes("solana:devnet" as any));
  const installed = candidates.find((w) => /phantom|solflare|backpack/i.test(w.name)) ?? candidates[0];
  if (!installed) throw new Error("no_solana_wallet_installed");
  return installed;
}

export function createWalletStandardPort(): SolanaWalletPort {
  let adapter: StandardWalletAdapter | null = null;
  const connection = new Connection(RPC_URL, "confirmed");
  const getAdapter = () => {
    adapter ??= new StandardWalletAdapter({ wallet: pickWallet() });
    return adapter;
  };
  return {
    kind: "web-standard",
    async connect() {
      const a = getAdapter();
      await a.connect();
      if (!a.publicKey) throw new Error("wallet_connect_failed");
      return { address: a.publicKey.toBase58(), label: a.name };
    },
    async disconnect() {
      await adapter?.disconnect();
      adapter = null;
    },
    currentAddress() {
      return adapter?.publicKey?.toBase58() ?? null;
    },
    async signMessage(message) {
      const a = getAdapter();
      if (!a.signMessage) throw new Error("wallet_sign_message_unsupported");
      return a.signMessage(message);
    },
    async signTransaction(txBase64) {
      const a = getAdapter();
      if (!a.signTransaction) throw new Error("wallet_sign_transaction_unsupported");
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      const signed = await a.signTransaction(tx);
      return Buffer.from(signed.serialize()).toString("base64");
    },
    async signAndSendTransaction(txBase64) {
      const a = getAdapter();
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      return a.sendTransaction(tx, connection, { skipPreflight: false });
    },
  };
}
```

- [ ] **Step 4: Create Seeker MWA port**

Create `redline3d/src/core/mobile-wallet-port.ts`:

```ts
import {
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
  SolanaMobileWalletAdapter,
} from "@solana-mobile/wallet-adapter-mobile";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { SolanaWalletPort } from "./solana-wallet";

const CLUSTER = ((import.meta.env?.VITE_SOLANA_CLUSTER as string) === "devnet"
  ? WalletAdapterNetwork.Devnet
  : WalletAdapterNetwork.Mainnet) as WalletAdapterNetwork;
const RPC_URL = (import.meta.env?.VITE_SOLANA_RPC_URL as string) ?? "https://api.mainnet-beta.solana.com";

export function createMobileWalletPort(): SolanaWalletPort {
  const adapter = new SolanaMobileWalletAdapter({
    addressSelector: createDefaultAddressSelector(),
    appIdentity: { name: "Redline", uri: location.origin, icon: "/icon-192.png" },
    authorizationResultCache: createDefaultAuthorizationResultCache(),
    cluster: CLUSTER,
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
  const connection = new Connection(RPC_URL, "confirmed");
  return {
    kind: "mobile-wallet-adapter",
    async connect() {
      await adapter.connect();
      if (!adapter.publicKey) throw new Error("wallet_connect_failed");
      return { address: adapter.publicKey.toBase58(), label: adapter.name };
    },
    async disconnect() {
      await adapter.disconnect();
    },
    currentAddress() {
      return adapter.publicKey?.toBase58() ?? null;
    },
    async signMessage(message) {
      return adapter.signMessage(message);
    },
    async signTransaction(txBase64) {
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      const signed = await adapter.signTransaction(tx);
      return Buffer.from(signed.serialize()).toString("base64");
    },
    async signAndSendTransaction(txBase64) {
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      return adapter.sendTransaction(tx, connection, { skipPreflight: false });
    },
  };
}
```

MWA connect must be invoked directly from a user tap or click because Android Chrome blocks wallet intent navigation outside a user gesture.

- [ ] **Step 5: Run wallet loader tests and client typecheck**

Run:

```bash
cd redline3d && npx vitest run src/core/solana-wallet.test.ts && npm run build
```

Expected:

```text
src/core/solana-wallet.test.ts passed
vite build completes
```

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/core/solana-wallet.ts redline3d/src/core/solana-wallet.test.ts redline3d/src/core/wallet-standard-port.ts redline3d/src/core/mobile-wallet-port.ts
git commit -m "feat(client): add solana wallet port"
```

---

## Task 8: Wire Wallet Binding And Deposit Funding In The Client

**Files:**
- Create: `redline3d/src/core/wallet-binding.ts`
- Create: `redline3d/src/core/wallet-binding.test.ts`
- Modify: `redline3d/src/core/play-funding.ts`
- Modify: `redline3d/src/core/play-funding.test.ts`
- Modify: `redline3d/src/ui/wallet.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: `SolanaWalletPort`, `Api.bindWalletChallenge`, `Api.bindWallet`, `Api.depositSend`.
- Produces: wallet screen connect, bind, wallet balance, and add-to-play behavior.

- [ ] **Step 1: Update `play-funding` wording and support server broadcast**

In `redline3d/src/core/play-funding.ts`, replace Privy wording in comments with connected wallet wording.

Change `signAndSend` comment to:

```ts
  /** sign and submit the deposit tx through the connected wallet or server broadcaster */
  signAndSend: (txBase64: string) => Promise<string>;
```

- [ ] **Step 2: Add wallet binding orchestrator tests**

Create `redline3d/src/core/wallet-binding.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { connectAndBindWallet } from "./wallet-binding";
import type { SolanaWalletPort } from "./solana-wallet";

describe("connectAndBindWallet", () => {
  it("connects, signs the server challenge, and binds the wallet", async () => {
    const port: SolanaWalletPort = {
      kind: "web-standard",
      connect: vi.fn(async () => ({ address: "Wallet1111111111111111111111111111111111" })),
      disconnect: vi.fn(),
      currentAddress: () => "Wallet1111111111111111111111111111111111",
      signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])),
      signTransaction: vi.fn(),
    };
    const api = {
      bindWalletChallenge: vi.fn(async () => ({ challenge: "challenge", message: "message", wallet: "Wallet1111111111111111111111111111111111", expiresAt: "x" })),
      bindWallet: vi.fn(async () => ({ wallet: "Wallet1111111111111111111111111111111111" })),
    };
    const out = await connectAndBindWallet({ port, api: api as any });
    expect(out.address).toBe("Wallet1111111111111111111111111111111111");
    expect(port.signMessage).toHaveBeenCalledWith(new TextEncoder().encode("message"));
    expect(api.bindWallet).toHaveBeenCalledWith({ challenge: "challenge", signatureBase58: "Ldp" });
  });
});
```

- [ ] **Step 3: Create `redline3d/src/core/wallet-binding.ts`**

```ts
import type { Api } from "./api";
import type { SolanaWalletPort } from "./solana-wallet";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export async function connectAndBindWallet(input: { port: SolanaWalletPort; api: Pick<Api, "bindWalletChallenge" | "bindWallet"> }) {
  const connected = await input.port.connect();
  const challenge = await input.api.bindWalletChallenge(connected.address);
  const signature = await input.port.signMessage(new TextEncoder().encode(challenge.message));
  const bound = await input.api.bindWallet({ challenge: challenge.challenge, signatureBase58: base58Encode(signature) });
  return { address: bound.wallet, label: connected.label };
}
```

- [ ] **Step 4: Refactor wallet UI copy and callbacks**

In `redline3d/src/ui/wallet.ts`, change `WalletOpts` to:

```ts
export interface WalletOpts {
  address: () => string;
  balance: () => number;
  walletBalance?: () => number | null;
  onConnectWallet?: () => Promise<void>;
  onBuy: (usd: number) => void;
  onLogout?: () => void;
  onWalletPoll?: () => Promise<number>;
  onAddToPlay?: () => Promise<void>;
}
```

Replace all visible copy containing `Privy wallet` with:

```text
Connected wallet balance
Use Receive to add USDC to your connected wallet.
This QR is your connected wallet. Send only USDC (SPL) on Solana. Add to play balance when the funds arrive.
```

When `addr` is empty, render a connect button in both Buy and Receive views:

```ts
const connectButton = `<button class="wlt-cta" id="wltConnect">Connect wallet</button>`;
```

After rendering, wire:

```ts
const connectBtn = panel.querySelector<HTMLButtonElement>("#wltConnect");
if (connectBtn) {
  connectBtn.onclick = async () => {
    if (!opts.onConnectWallet) return;
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting...";
    try {
      await opts.onConnectWallet();
      renderAddressUI();
      renderBalance();
    } catch {
      connectBtn.textContent = "Connect failed";
      window.setTimeout(() => { connectBtn.textContent = "Connect wallet"; connectBtn.disabled = false; }, 1400);
      return;
    }
    connectBtn.disabled = false;
  };
}
```

- [ ] **Step 5: Wire wallet port in `main.ts`**

Add imports:

```ts
import { loadSolanaWalletPort, type SolanaWalletPort } from "./core/solana-wallet";
import { connectAndBindWallet } from "./core/wallet-binding";
```

Add state near wallet balance:

```ts
let walletPort: SolanaWalletPort | null = null;
let connectedWalletAddress = "";
```

Replace `refreshWalletBalance` guard:

```ts
  if (!connectedWalletAddress) {
    walletBalance = null;
    return;
  }
```

Add helper:

```ts
async function ensureWalletConnected(): Promise<SolanaWalletPort> {
  walletPort ??= await loadSolanaWalletPort("auto");
  const bound = await connectAndBindWallet({ port: walletPort, api });
  connectedWalletAddress = bound.address;
  await refreshWalletBalance();
  syncDisplayedBalance();
  walletUI.setBalance(balance);
  return walletPort;
}
```

In `createWallet`, replace address and buy handlers:

```ts
  address: () => connectedWalletAddress,
  onConnectWallet: async () => { await ensureWalletConnected(); },
  onBuy: () => { hud.setStatus("Use Receive to add USDC to your connected wallet."); },
```

Replace `onAddToPlay` signing:

```ts
  onAddToPlay: async () => {
    const port = walletPort ?? await ensureWalletConnected();
    const walletCents = walletBalance ?? 0;
    serverBalance = await sweepToPlayBalance({
      walletBalanceCents: walletCents,
      startingServerBalance: serverBalance,
      buildDepositTx: async (amountCents) => (await api.depositBuild(amountCents)).txBase64,
      signAndSend: async (txBase64) => {
        if (port.signAndSendTransaction) return port.signAndSendTransaction(txBase64);
        const signedTxBase64 = await port.signTransaction(txBase64);
        return (await api.depositSend({ expectedTxBase64: txBase64, signedTxBase64 })).txSig;
      },
      pollServerBalance: async () => {
        const me = await api.me();
        serverBalance = me.balance;
        try { await refreshWalletBalance(); } catch {}
        syncDisplayedBalance();
        walletUI.setBalance(balance);
        return serverBalance;
      },
    });
    syncDisplayedBalance();
    walletUI.setBalance(balance);
  },
```

Replace every `auth.walletPublicKey?.()` check with `connectedWalletAddress`.

- [ ] **Step 6: Assert wallet SDKs are not imported by `GO!` path**

Add or update `redline3d/src/core/solana-wallet.test.ts`:

```ts
it("keeps wallet SDKs behind dynamic imports", async () => {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");
  expect(main).not.toContain("@wallet-standard/app");
  expect(main).not.toContain("@solana-mobile/wallet-adapter-mobile");
  expect(main).toContain("loadSolanaWalletPort");
});
```

- [ ] **Step 7: Run client wallet tests**

Run:

```bash
cd redline3d && npx vitest run src/core/wallet-binding.test.ts src/core/solana-wallet.test.ts src/core/play-funding.test.ts src/ui/wallet.test.ts
```

Expected:

```text
Test Files  4 passed
Tests       ... passed
```

- [ ] **Step 8: Commit**

```bash
git add redline3d/src
git commit -m "feat(client): wire external solana wallets"
```

---

## Task 9: Remove Privy Client Files And Packages

**Files:**
- Delete: `redline3d/src/core/auth-privy.ts`
- Delete: `redline3d/src/core/privy-island.ts`
- Modify: `redline3d/package.json`
- Modify: `redline3d/package-lock.json`
- Modify: `redline3d/src/ui/auth-ui.test.ts`
- Modify: `redline3d/src/ui/controls.ts`

**Interfaces:**
- Consumes: session auth and wallet port from earlier tasks.
- Produces: no Privy code in client source or dependencies.

- [ ] **Step 1: Delete Privy client modules**

Run:

```bash
rm redline3d/src/core/auth-privy.ts redline3d/src/core/privy-island.ts
```

Expected: command exits `0`.

- [ ] **Step 2: Remove Privy and React packages**

In `redline3d/package.json`, remove:

```json
"@privy-io/react-auth": "^3.32.1",
"react": "^18.3.1",
"react-dom": "^18.3.1"
```

From `devDependencies`, remove:

```json
"@types/react": "^19.2.17",
"@types/react-dom": "^19.2.3"
```

Run:

```bash
cd redline3d && npm install
```

Expected: exit code `0`.

- [ ] **Step 3: Remove Privy DOM exceptions**

In `redline3d/src/ui/controls.ts`, replace:

```ts
      el.isContentEditable === true || !!el.closest?.("#privy-root")
```

with:

```ts
      el.isContentEditable === true
```

- [ ] **Step 4: Update auth UI tests**

In `redline3d/src/ui/auth-ui.test.ts`, replace assertions that mention Privy login or modal behavior with session wording:

```ts
expect(button.textContent).not.toContain("Privy");
```

If the file only tests `shortWallet`, keep those tests and remove Privy-specific cases.

- [ ] **Step 5: Scan client source**

Run:

```bash
rg -n "Privy|privy|@privy|privy-root|VITE_PRIVY" redline3d/src redline3d/package.json
```

Expected:

```text
no matches
```

- [ ] **Step 6: Run client tests and build**

Run:

```bash
cd redline3d && npm test && npm run build
```

Expected:

```text
Test Files  ... passed
vite build completes
```

The build output should no longer contain a `privy-island` chunk.

- [ ] **Step 7: Commit**

```bash
git add redline3d
git commit -m "refactor(client): remove privy"
```

---

## Task 10: Remove Privy Server Files And Packages

**Files:**
- Delete: `server/src/auth/privy.ts`
- Delete: `server/src/auth/privy.test.ts`
- Delete: `server/src/auth/privy-wallet.ts`
- Delete: `server/src/auth/privy-wallet.test.ts`
- Delete: `server/src/scripts/phase0-staging.ts`
- Delete: `server/src/scripts/create-treasury.ts`
- Delete: `server/src/solana/withdraw-signer.ts`
- Delete: `server/src/solana/withdraw-signer.test.ts`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Modify: `server/src/env.ts`
- Modify: `server/src/services/withdraw-worker.ts`
- Modify: `server/src/services/withdraw-worker.test.ts`
- Modify: `server/src/test/env.real-money.test.ts`

**Interfaces:**
- Consumes: session auth, wallet binding, fee-payer signer.
- Produces: no Privy package or import in server source.

- [ ] **Step 1: Delete Privy server modules and scripts**

Run:

```bash
rm server/src/auth/privy.ts \
  server/src/auth/privy.test.ts \
  server/src/auth/privy-wallet.ts \
  server/src/auth/privy-wallet.test.ts \
  server/src/scripts/phase0-staging.ts \
  server/src/scripts/create-treasury.ts \
  server/src/solana/withdraw-signer.ts \
  server/src/solana/withdraw-signer.test.ts
```

Expected: command exits `0`.

- [ ] **Step 2: Remove Privy env fields**

In `server/src/env.ts`, delete:

```ts
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  PRIVY_PLAY_SIGNER_ID: z.string().min(1).optional(),
  PRIVY_PLAY_SIGNER_PRIVATE_KEY: z.string().min(1).optional(),
  PRIVY_PLAY_SIGNER_POLICY_IDS: z.string().optional(),
  PRIVY_VERIFICATION_KEY: z.string().optional(),
  TREASURY_WALLET_ID: z.string().min(1).optional(),
```

Delete the `PRIVY_PLAY_SIGNER_ID` and `PRIVY_PLAY_SIGNER_PRIVATE_KEY` paired validation block.

- [ ] **Step 3: Remove `@privy-io/node`**

In `server/package.json`, remove:

```json
"@privy-io/node": "^0.22.0"
```

Run:

```bash
cd server && npm install
```

Expected: exit code `0`.

- [ ] **Step 4: Rename provider-specific withdrawal fields in TypeScript code**

In `server/src/services/withdraw-worker.ts`, rename returned object fields from `privyTxId` to `providerTxId` where possible without changing database column names in this task.

The signer interface used by withdraw worker should be local:

```ts
export interface WithdrawSigner {
  signAndSend(input: { destWallet: string; amountCents: number; idempotencyKey: string }): Promise<{ txSig: string; providerTxId: string | null }>;
}
```

Update tests in `server/src/services/withdraw-worker.test.ts` to assert `providerTxId`.

- [ ] **Step 5: Scan server source**

Run:

```bash
rg -n "@privy|PrivyClient|makePrivy|privyAuth|PRIVY_" server/src server/package.json
```

Expected:

```text
no matches
```

Historical migration column names can still contain `privy_` because renaming persisted money-table columns is a separate database migration.

- [ ] **Step 6: Run server tests and build**

Run:

```bash
cd server && npm test && npm run build
```

Expected:

```text
Test Files  ... passed
tsc --noEmit completes
```

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "refactor(server): remove privy"
```

---

## Task 11: End-To-End Verification And Manual Seeker Check

**Files:**
- Modify only when verification exposes a defect in files touched by Tasks 1-10.

**Interfaces:**
- Consumes: completed migration.
- Produces: verified web and Seeker funding behavior, instant `GO!`, no Privy source dependency.

- [ ] **Step 1: Run full repo verification**

Run:

```bash
cd redline3d && npm test && npm run build
cd ../server && npm test && npm run build
```

Expected:

```text
redline3d tests pass
redline3d build passes
server tests pass
server build passes
```

- [ ] **Step 2: Run source scans**

Run:

```bash
rg -n "@privy|PrivyClient|privy-island|auth-privy|VITE_PRIVY|Privy wallet" redline3d/src server/src redline3d/package.json server/package.json
```

Expected:

```text
no matches
```

Run:

```bash
rg -n "@wallet-standard/app|@solana-mobile/wallet-adapter-mobile|@solana/web3.js" redline3d/src/main.ts redline3d/src/ui
```

Expected:

```text
no matches
```

Run:

```bash
rg -n "loadSolanaWalletPort|connectAndBindWallet" redline3d/src/main.ts
```

Expected:

```text
redline3d/src/main.ts contains both names
```

- [ ] **Step 3: Start local server and client**

Terminal 1:

```bash
cd server && npm run dev
```

Expected:

```text
perps server listening on http://0.0.0.0:8080
```

Terminal 2:

```bash
cd redline3d && npm run dev -- --host 0.0.0.0
```

Expected:

```text
Local:   http://localhost:5173/
```

- [ ] **Step 4: Manual web check**

Use a browser with Phantom, Solflare, or Backpack installed:

```text
1. Load http://localhost:5173/.
2. Confirm the 3D scene appears without a wallet modal.
3. Press GO! with zero cash.
4. Confirm the wallet screen opens and no wallet browser extension opens automatically.
5. Click Connect wallet.
6. Confirm exactly one wallet connect prompt appears.
7. Sign the wallet binding message.
8. Confirm wallet address and USDC balance appear.
9. Click Add to play balance.
10. Confirm exactly one transaction approval appears.
11. After server cash credits, press GO!.
12. Confirm the round opens without a wallet prompt.
```

- [ ] **Step 5: Manual Seeker check**

On Solana Seeker or an Android device with an MWA-compatible wallet:

```text
1. Install the Capacitor build.
2. Open the app.
3. Confirm the scene appears without a wallet prompt.
4. Open wallet screen.
5. Tap Connect wallet.
6. Confirm MWA opens from the tap and returns to the app after approval.
7. Sign the wallet binding message.
8. Tap Add to play balance.
9. Confirm MWA presents one transaction approval.
10. Press GO! after cash credits.
11. Confirm the round opens without MWA.
```

- [ ] **Step 6: Commit verification fixes**

If Step 1 through Step 5 required code changes, run:

```bash
git add redline3d server
git commit -m "fix: complete wallet adapter migration verification"
```

If no code changes were needed, record the verification result in the task tracker and do not create an empty commit.
