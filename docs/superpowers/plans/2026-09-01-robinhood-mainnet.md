# Robinhood Chain Mainnet Pivot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Slopwheels' real-money loop to Robinhood Chain (EVM, id 4663): EOA USDC treasury rails, EIP-191 wallet binding, Privy EVM wallets, server-authoritative rounds with an autonomous cash settler, server-handled Pyth with WS fan-out, commit-reveal crates — Solana parked behind flags.

**Architecture:** The server's money services (`Deposits.recordInbound`, withdraw reserve→approve→send→confirm, ledger, rounds engine) are chain-agnostic and are reused verbatim; only the chain adapters (`server/src/evm/*`) are new. The client swaps its MagicBlock-ER `session` for a new server-rounds adapter speaking the already-existing `/v1/round/*` API, and its direct Pyth connections for a server WS feed.

**Tech Stack:** viem (server + client EVM), Fastify + @fastify/websocket (existing), drizzle/Postgres (existing), Privy `@privy-io/react-auth` v3 EVM surface, vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-robinhood-mainnet-design.md`

---

## Ground rules for every task

- Branch: `robinhood-mainnet`. Commit after every task (steps say when).
- Server tests: `cd server && npm test -- <file>` (vitest). Client: `cd redline3d && npm test -- <file>`.
- Type checks: `cd server && npm run build` / `cd redline3d && npx tsc --noEmit`.
- NEVER weaken the fail-closed money guards (withdraw admin gate, `assertRoundSettlerForStake`, quarantine).
- EVM addresses are stored and compared **lowercased** everywhere on the server.
- Solana code is PARKED, not deleted (exceptions named explicitly: client Lazer feed internals, `appsigner.ts`).
- Before using a Privy hook/type, verify its exact name against the installed types in `redline3d/node_modules/@privy-io/react-auth/dist/**/*.d.ts` — do not trust this plan's memory of the Privy API over the installed package.

### Verified chain facts (do not re-derive)

| | Mainnet | Testnet |
|---|---|---|
| Chain id | 4663 | 46630 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | robinhoodchain.blockscout.com | explorer.testnet.chain.robinhood.com |

Gas token ETH. Canonical USDC address: resolve at deploy time via the Arbitrum L2 Gateway Router (`calculateL2TokenAddress(l1USDC)`) — an env value, never hardcoded.

---

## Phase A — server EVM rail

### Task A1: env — `CHAIN_FAMILY` + EVM vars, family-scoped refinement

**Files:**
- Modify: `server/src/env.ts`
- Test: `server/src/env.test.ts` (exists — extend), `server/src/test/env.real-money.test.ts` (exists — extend)

- [ ] **Step 1: Write failing tests** (append to `server/src/test/env.real-money.test.ts`):

```ts
describe("CHAIN_FAMILY", () => {
  it("defaults to evm", () => {
    expect(parseEnv({}).CHAIN_FAMILY).toBe("evm");
  });
  it("evm family requires EVM vars when real money is on", () => {
    expect(() => parseEnv({ REAL_MONEY_ENABLED: "true" })).toThrow(/EVM_RPC_URL/);
    expect(() =>
      parseEnv({
        REAL_MONEY_ENABLED: "true",
        EVM_RPC_URL: "https://rpc.testnet.chain.robinhood.com",
        EVM_CHAIN_ID: "46630",
        EVM_USDC_ADDRESS: "0x" + "a".repeat(40),
        EVM_TREASURY_ADDRESS: "0x" + "b".repeat(40),
      }),
    ).not.toThrow();
  });
  it("solana family keeps the old requirements", () => {
    expect(() => parseEnv({ REAL_MONEY_ENABLED: "true", CHAIN_FAMILY: "solana" })).toThrow(/SOLANA_RPC_URL/);
  });
  it("EVM_TREASURY_SECRET requires EVM_TREASURY_ADDRESS", () => {
    expect(() =>
      parseEnv({ CHAIN_FAMILY: "evm", EVM_TREASURY_SECRET: "0x" + "1".repeat(64) }),
    ).toThrow(/EVM_TREASURY_ADDRESS/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd server && npm test -- env.real-money` → FAIL (unknown key `CHAIN_FAMILY`).

- [ ] **Step 3: Implement** in `server/src/env.ts`. Add to `EnvShape`:

```ts
  CHAIN_FAMILY: z.enum(["evm", "solana"]).default("evm"),
  EVM_RPC_URL: z.string().url().optional(),
  EVM_RPC_URL_FALLBACK: z.string().url().optional(),
  EVM_CHAIN_ID: z.coerce.number().int().positive().optional(),
  EVM_USDC_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  EVM_TREASURY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  EVM_TREASURY_SECRET: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  EVM_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
```

In the `superRefine`, scope the existing Solana block to `CHAIN_FAMILY === "solana"` and add the EVM block:

```ts
  if (!e.REAL_MONEY_ENABLED) { /* keep the TREASURY_SECRET/OWNER pairing checks below this guard as-is */ }
  if (e.REAL_MONEY_ENABLED && e.CHAIN_FAMILY === "solana") {
    for (const k of ["SOLANA_RPC_URL", "USDC_MINT", "TREASURY_USDC_ATA"] as const) { /* existing loop */ }
    /* existing FEE_PAYER / TREASURY_OWNER pairing checks stay inside this branch */
  }
  if (e.REAL_MONEY_ENABLED && e.CHAIN_FAMILY === "evm") {
    for (const k of ["EVM_RPC_URL", "EVM_CHAIN_ID", "EVM_USDC_ADDRESS", "EVM_TREASURY_ADDRESS"] as const) {
      if (!e[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required when REAL_MONEY_ENABLED=true and CHAIN_FAMILY=evm` });
    }
  }
  if (e.EVM_TREASURY_SECRET && !e.EVM_TREASURY_ADDRESS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["EVM_TREASURY_ADDRESS"], message: "EVM_TREASURY_ADDRESS is required when EVM_TREASURY_SECRET is set" });
  }
```

Careful: the existing early-return `if (!e.REAL_MONEY_ENABLED) return;` must stay so non-money boots skip both families — but move the `TREASURY_SECRET && !TREASURY_OWNER_PUBKEY` check into the solana branch (it is Solana-specific).

- [ ] **Step 4: Run tests** — `npm test -- env` → PASS (both env test files).
- [ ] **Step 5: Commit** — `git commit -am "feat(server): CHAIN_FAMILY env seam with family-scoped money-var refinement"`

### Task A2: viem dep + EVM client factory

**Files:**
- Modify: `server/package.json`
- Create: `server/src/evm/client.ts`
- Test: `server/src/evm/client.test.ts`

- [ ] **Step 1:** `cd server && npm install viem` (pin whatever latest resolves; commit the lockfile).
- [ ] **Step 2: Failing test** `server/src/evm/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defineEvmChain } from "./client.js";

describe("defineEvmChain", () => {
  it("builds a viem chain from env values", () => {
    const chain = defineEvmChain({ chainId: 4663, rpcUrl: "https://rpc.mainnet.chain.robinhood.com" });
    expect(chain.id).toBe(4663);
    expect(chain.rpcUrls.default.http[0]).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(chain.nativeCurrency.symbol).toBe("ETH");
  });
});
```

- [ ] **Step 3: Implement** `server/src/evm/client.ts`:

```ts
import { createPublicClient, createWalletClient, defineChain, fallback, http, type Chain, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function defineEvmChain(cfg: { chainId: number; rpcUrl: string }): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 4663 ? "Robinhood Chain" : `evm-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

export function makePublicClient(cfg: { chainId: number; rpcUrl: string; rpcUrlFallback?: string }): PublicClient {
  const chain = defineEvmChain(cfg);
  const transport = cfg.rpcUrlFallback ? fallback([http(cfg.rpcUrl), http(cfg.rpcUrlFallback)]) : http(cfg.rpcUrl);
  return createPublicClient({ chain, transport });
}

export function makeTreasuryWalletClient(cfg: { chainId: number; rpcUrl: string; secret: `0x${string}` }): { client: WalletClient; address: string } {
  const chain = defineEvmChain({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl });
  const account = privateKeyToAccount(cfg.secret);
  return { client: createWalletClient({ chain, account, transport: http(cfg.rpcUrl) }), address: account.address.toLowerCase() };
}
```

- [ ] **Step 4:** `npm test -- evm/client` → PASS. `npm run build` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): viem client factory for Robinhood Chain"`

### Task A3: generic token label for `Deposits` (unblock non-Solana rails)

`makeDeposits` hard-rejects any transfer whose `tokenProgram !== LEGACY_TOKEN_PROGRAM` (`server/src/services/deposits.ts:45`). Make the expected label configurable, defaulting to the Solana value so all existing behavior and tests hold.

**Files:**
- Modify: `server/src/services/deposits.ts`
- Test: `server/src/services/deposits.test.ts` (exists — extend)

- [ ] **Step 1: Failing test** (append; mirror the file's existing fixture helpers for db/ledger — reuse them):

```ts
it("accepts a transfer whose tokenProgram matches a configured expected label", async () => {
  const svc = makeDeposits(db, ledger, { ...cfg, expectedTokenProgram: "erc20" });
  const out = await svc.recordInbound({ ...baseTransfer, tokenProgram: "erc20" });
  expect(out.status).toBe("credited");
});
```

- [ ] **Step 2:** run → FAIL (`expectedTokenProgram` not a config key; transfer quarantined `wrong_program`).
- [ ] **Step 3: Implement** — in `deposits.ts`: add `expectedTokenProgram?: string` to `DepositsConfig`; in `makeDeposits` compute `const expectedProgram = cfg.expectedTokenProgram ?? LEGACY_TOKEN_PROGRAM;` and change line 45's comparison to `t.tokenProgram !== expectedProgram`.
- [ ] **Step 4:** `npm test -- deposits` → PASS (all existing cases still green — default unchanged).
- [ ] **Step 5: Commit** — `git commit -am "feat(server): configurable expected token label in Deposits (EVM rail prep)"`

### Task A4: EVM deposit source + block-cursored confirmer

The Solana confirmer paginates a signature history; EVM scans block ranges. Same `Deposits`/cursor-store reuse, EVM-native loop. Reuse the `deposit_cursors` table via the existing `makeDbDepositCursorStore` (the cursor value is a stringified block number; the `treasuryAta` key is the lowercased treasury address).

**Files:**
- Create: `server/src/evm/deposit-source.ts`, `server/src/evm/deposit-confirmer.ts`
- Test: `server/src/evm/deposit-source.test.ts`, `server/src/evm/deposit-confirmer.test.ts`

- [ ] **Step 1: Failing tests.** `deposit-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inboundFromLog, makeEvmDepositSource } from "./deposit-source.js";

const USDC = "0x" + "a".repeat(40);
const TREASURY = "0x" + "b".repeat(40);
const FROM = "0x" + "c".repeat(40);

describe("inboundFromLog", () => {
  const log = {
    address: USDC, transactionHash: "0x" + "1".repeat(64), blockNumber: 100n,
    args: { from: FROM.toUpperCase().replace("0X", "0x"), to: TREASURY, value: 5_000_000n }, // 5 USDC, mixed-case from
  };
  it("maps a Transfer log to InboundTransfer with lowercased addresses", () => {
    const t = inboundFromLog(log as never, { usdc: USDC, treasury: TREASURY });
    expect(t).toEqual({
      txSig: log.transactionHash, slot: 100, finalized: true, mint: USDC,
      tokenProgram: "erc20", destAta: TREASURY, sourceOwner: FROM, amountBaseUnits: 5_000_000n,
    });
  });
});

describe("makeEvmDepositSource", () => {
  it("fetches only up to latest - confirmations and reads token decimals", async () => {
    const calls: unknown[] = [];
    const pub = {
      getBlockNumber: async () => 120n,
      getLogs: async (q: unknown) => { calls.push(q); return []; },
      readContract: async () => 6,
      getBalance: async () => 0n,
    };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    const page = await src.fetchInboundRange({ fromBlock: 90n });
    expect(page.toBlock).toBe(100n); // 120 - 20
    expect((calls[0] as { fromBlock: bigint }).fromBlock).toBe(90n);
    expect(await src.tokenDecimals()).toBe(6);
  });
  it("returns an empty page without calling getLogs when the safe head is behind fromBlock", async () => {
    const pub = { getBlockNumber: async () => 100n, getLogs: async () => { throw new Error("must not"); }, readContract: async () => 6 };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    const page = await src.fetchInboundRange({ fromBlock: 90n });
    expect(page.transfers).toEqual([]);
    expect(page.toBlock).toBe(89n); // nothing scanned; cursor must not advance
  });
});
```

`deposit-confirmer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeEvmDepositConfirmer } from "./deposit-confirmer.js";

describe("makeEvmDepositConfirmer", () => {
  const t = (block: number, sig: string) => ({
    txSig: sig, slot: block, finalized: true, mint: "0xa", tokenProgram: "erc20",
    destAta: "0xb", sourceOwner: "0xc", amountBaseUnits: 1_000_000n,
  });
  it("processes a range oldest-first and persists the cursor AFTER crediting", async () => {
    const seen: string[] = [];
    let stored: string | undefined;
    const confirmer = makeEvmDepositConfirmer({
      deposits: { recordInbound: async (x) => { seen.push(x.txSig); return { status: "credited", userId: "u", amountCents: 100 }; } },
      source: { fetchInboundRange: async () => ({ transfers: [t(101, "0x1"), t(102, "0x2")], toBlock: 110n }) },
      store: { get: async () => stored, set: async (_k, v) => { stored = v; } },
      treasury: "0xb", pollMs: 60_000, startBlock: 100n,
    });
    await confirmer.tick();
    expect(seen).toEqual(["0x1", "0x2"]);
    expect(stored).toBe("110");
  });
  it("does not persist the cursor when crediting throws", async () => {
    let stored: string | undefined;
    const confirmer = makeEvmDepositConfirmer({
      deposits: { recordInbound: async () => { throw new Error("db down"); } },
      source: { fetchInboundRange: async () => ({ transfers: [t(101, "0x1")], toBlock: 110n }) },
      store: { get: async () => stored, set: async (_k, v) => { stored = v; } },
      treasury: "0xb", pollMs: 60_000, startBlock: 100n,
    });
    await expect(confirmer.tick()).rejects.toThrow();
    expect(stored).toBeUndefined();
  });
});
```

- [ ] **Step 2:** run both → FAIL (modules missing).
- [ ] **Step 3: Implement.** `server/src/evm/deposit-source.ts`:

```ts
import { erc20Abi, parseAbiItem, type PublicClient } from "viem";
import type { InboundTransfer } from "../services/deposits.js";

export const EVM_TOKEN_LABEL = "erc20";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface EvmInboundPage { transfers: InboundTransfer[]; toBlock: bigint; }
export interface EvmDepositSource {
  /** Scan [fromBlock, latest - confirmations] for USDC Transfer→treasury. toBlock is the last block actually covered. */
  fetchInboundRange(opts: { fromBlock: bigint }): Promise<EvmInboundPage>;
  tokenDecimals(): Promise<number>;
  readTreasuryBaseUnits(): Promise<bigint>;
}

type TransferLog = { address: string; transactionHash: string; blockNumber: bigint; args: { from: string; to: string; value: bigint } };

export function inboundFromLog(log: TransferLog, cfg: { usdc: string; treasury: string }): InboundTransfer {
  return {
    txSig: log.transactionHash,
    slot: Number(log.blockNumber), // fits: EVM block heights ≪ 2^53
    finalized: true,               // the source only ever scans ≤ latest - confirmations
    mint: cfg.usdc.toLowerCase(),
    tokenProgram: EVM_TOKEN_LABEL,
    destAta: cfg.treasury.toLowerCase(),
    sourceOwner: log.args.from.toLowerCase(),
    amountBaseUnits: log.args.value,
  };
}

export function makeEvmDepositSource(
  client: PublicClient,
  cfg: { usdc: string; treasury: string; confirmations: number },
): EvmDepositSource {
  const usdc = cfg.usdc.toLowerCase() as `0x${string}`;
  const treasury = cfg.treasury.toLowerCase() as `0x${string}`;
  return {
    async fetchInboundRange({ fromBlock }) {
      const head = await client.getBlockNumber();
      const safeHead = head - BigInt(cfg.confirmations);
      if (safeHead < fromBlock) return { transfers: [], toBlock: fromBlock - 1n }; // nothing safe yet; cursor holds
      const logs = await client.getLogs({ address: usdc, event: TRANSFER, args: { to: treasury }, fromBlock, toBlock: safeHead });
      const transfers = (logs as unknown as TransferLog[])
        .filter((l) => !("removed" in l) || !(l as { removed?: boolean }).removed)
        .map((l) => inboundFromLog(l, { usdc, treasury }));
      return { transfers, toBlock: safeHead };
    },
    tokenDecimals: () => client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    readTreasuryBaseUnits: () => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }) as Promise<bigint>,
  };
}
```

`server/src/evm/deposit-confirmer.ts` (mirror the Solana confirmer's crash-safety comments and shape — `server/src/services/deposit-worker.ts:38-78`):

```ts
import type { DepositCursorStore } from "../services/deposit-worker.js";
import type { InboundTransfer } from "../services/deposits.js";
import type { EvmDepositSource } from "./deposit-source.js";

export interface EvmDepositConfirmerOpts {
  deposits: { recordInbound(t: InboundTransfer): Promise<unknown> };
  source: Pick<EvmDepositSource, "fetchInboundRange">;
  store: DepositCursorStore;               // reuse deposit_cursors; key = lowercased treasury, value = last scanned block
  treasury: string;
  pollMs: number;
  /** first block to scan when no cursor exists yet (deploy-time head; avoids scanning genesis). */
  startBlock: bigint;
}

export function makeEvmDepositConfirmer(opts: EvmDepositConfirmerOpts) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const key = opts.treasury.toLowerCase();

  async function tick(): Promise<void> {
    const stored = await opts.store.get(key);
    const fromBlock = stored !== undefined ? BigInt(stored) + 1n : opts.startBlock;
    const page = await opts.source.fetchInboundRange({ fromBlock });
    if (page.toBlock < fromBlock) return; // safe head hasn't reached us; do not advance
    // oldest-first so a crash mid-range leaves the cursor behind, never ahead (recordInbound is idempotent)
    for (const t of [...page.transfers].sort((a, b) => a.slot - b.slot)) await opts.deposits.recordInbound(t);
    await opts.store.set(key, page.toBlock.toString());
  }

  return {
    tick,
    start() {
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), opts.pollMs);
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
```

- [ ] **Step 4:** `npm test -- evm/` → PASS. `npm run build` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): EVM deposit source + block-cursored confirmer"`

### Task A5: EVM treasury withdraw signer + chain status

**Files:**
- Create: `server/src/evm/treasury-signer.ts`, `server/src/evm/chain-status.ts`
- Test: `server/src/evm/treasury-signer.test.ts`, `server/src/evm/chain-status.test.ts`

- [ ] **Step 1: Failing tests.** `treasury-signer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeEvmTreasurySigner } from "./treasury-signer.js";

describe("makeEvmTreasurySigner", () => {
  it("sends an ERC-20 transfer of exact cents→base-units to the dest wallet", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const wallet = { writeContract: async (args: Record<string, unknown>) => { writes.push(args); return "0x" + "9".repeat(64); } };
    const signer = makeEvmTreasurySigner(wallet as never, { usdc: "0x" + "a".repeat(40) });
    const res = await signer.signAndSend({ destWallet: "0x" + "d".repeat(40), amountCents: 250, idempotencyKey: "k" });
    expect(res.txSig).toBe("0x" + "9".repeat(64));
    expect(res.providerTxId).toBeNull();
    expect(writes[0].functionName).toBe("transfer");
    expect((writes[0].args as unknown[])[1]).toBe(2_500_000n); // $2.50 → 2.5 USDC base units
  });
});
```

`chain-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapReceiptStatus, makeEvmChainStatusReader } from "./chain-status.js";

describe("mapReceiptStatus", () => {
  it("finalized only when success AND deep enough", () => {
    expect(mapReceiptStatus({ status: "success", blockNumber: 100n }, 120n, 12)).toBe("finalized");
    expect(mapReceiptStatus({ status: "success", blockNumber: 115n }, 120n, 12)).toBe("unknown");
    expect(mapReceiptStatus({ status: "reverted", blockNumber: 100n }, 120n, 12)).toBe("failed");
    expect(mapReceiptStatus(null, 120n, 12)).toBe("unknown");
  });
});

describe("makeEvmChainStatusReader", () => {
  it("treats a not-found receipt as unknown (still pending)", async () => {
    const pub = { getTransactionReceipt: async () => { throw new Error("TransactionReceiptNotFoundError"); }, getBlockNumber: async () => 1n };
    const read = makeEvmChainStatusReader(pub as never, 12);
    expect(await read("0x" + "1".repeat(64))).toBe("unknown");
  });
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** `server/src/evm/treasury-signer.ts`:

```ts
import { erc20Abi, type WalletClient } from "viem";
import { centsToBaseUnits } from "../money/usdc.js";
import type { WithdrawSigner } from "../services/withdraw-worker.js";

/**
 * EVM treasury withdraw signer. Exactly-once is the caller's DB state machine
 * (awaiting_approval → signing claims the row; a `sent` row is never re-sent) —
 * same contract as the Solana signer; `idempotencyKey` satisfies the port unused.
 * Nonces: viem's wallet client fills them; withdraw-worker sends serially.
 */
export function makeEvmTreasurySigner(wallet: WalletClient, cfg: { usdc: string }): WithdrawSigner {
  const usdc = cfg.usdc.toLowerCase() as `0x${string}`;
  return {
    async signAndSend({ destWallet, amountCents }) {
      const txSig = await wallet.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [destWallet as `0x${string}`, centsToBaseUnits(BigInt(amountCents))],
        chain: wallet.chain,
        account: wallet.account!,
      });
      return { txSig, providerTxId: null };
    },
  };
}
```

`server/src/evm/chain-status.ts`:

```ts
import type { PublicClient } from "viem";
import type { ChainStatus, ReadChainStatus } from "../services/withdraw-worker.js";

type ReceiptLite = { status: "success" | "reverted"; blockNumber: bigint } | null;

/** Pure mapping mirroring solana/chain-status.ts: reverted = failed; success = finalized only past the confirmation depth. */
export function mapReceiptStatus(receipt: ReceiptLite, head: bigint, confirmations: number): ChainStatus {
  if (!receipt) return "unknown";
  if (receipt.status === "reverted") return "failed";
  return head - receipt.blockNumber >= BigInt(confirmations) ? "finalized" : "unknown";
}

export function makeEvmChainStatusReader(client: PublicClient, confirmations: number): ReadChainStatus {
  return async (txSig) => {
    let receipt: ReceiptLite = null;
    try {
      receipt = (await client.getTransactionReceipt({ hash: txSig as `0x${string}` })) as unknown as ReceiptLite;
    } catch { return "unknown"; } // not yet mined (viem throws TransactionReceiptNotFound)
    return mapReceiptStatus(receipt, await client.getBlockNumber(), confirmations);
  };
}
```

- [ ] **Step 4:** `npm test -- evm/` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): EVM treasury withdraw signer + receipt-based chain status"`

### Task A6: wire the EVM rail into boot

**Files:**
- Modify: `server/src/index.ts` (the `if (env.REAL_MONEY_ENABLED)` block, lines 65-148)
- Test: `server/src/test/evm-boot-wiring.test.ts` (new; unit-test the extracted wiring fn)

- [ ] **Step 1:** Extract the family decision into a testable helper `server/src/evm/boot.ts`:

```ts
import { makePublicClient, makeTreasuryWalletClient } from "./client.js";
import { makeEvmDepositSource, EVM_TOKEN_LABEL } from "./deposit-source.js";
import { makeEvmDepositConfirmer } from "./deposit-confirmer.js";
import { makeEvmTreasurySigner } from "./treasury-signer.js";
import { makeEvmChainStatusReader } from "./chain-status.js";
import { USDC_DECIMALS } from "../money/usdc.js";
import type { Env } from "../env.js";

/** Build every EVM rail component from env. Throws (refuses boot) on a wrong-decimals token. */
export async function bootEvmRail(env: Env, deps: { db: unknown; makeDeposits: typeof import("../services/deposits.js").makeDeposits; ledger: import("../services/ledger.js").Ledger }) {
  const pub = makePublicClient({ chainId: env.EVM_CHAIN_ID!, rpcUrl: env.EVM_RPC_URL!, rpcUrlFallback: env.EVM_RPC_URL_FALLBACK });
  const treasury = env.EVM_TREASURY_ADDRESS!.toLowerCase();
  const source = makeEvmDepositSource(pub, { usdc: env.EVM_USDC_ADDRESS!, treasury, confirmations: env.EVM_CONFIRMATIONS });
  const decimals = await source.tokenDecimals();
  if (decimals !== USDC_DECIMALS) throw new Error(`refusing to boot: EVM_USDC_ADDRESS has ${decimals} decimals, expected ${USDC_DECIMALS}`);
  const deposits = deps.makeDeposits(deps.db, deps.ledger, {
    usdcMint: env.EVM_USDC_ADDRESS!.toLowerCase(), treasuryAta: treasury,
    minCents: env.DEPOSIT_MIN_CENTS, maxCents: env.DEPOSIT_MAX_CENTS,
    expectedTokenProgram: EVM_TOKEN_LABEL,
  });
  const startBlock = await pub.getBlockNumber(); // fresh deploy: scan forward from now
  let treasurySigner: ReturnType<typeof makeEvmTreasurySigner> | null = null;
  let treasurySignerAddress: string | null = null;
  if (env.EVM_TREASURY_SECRET) {
    const w = makeTreasuryWalletClient({ chainId: env.EVM_CHAIN_ID!, rpcUrl: env.EVM_RPC_URL!, secret: env.EVM_TREASURY_SECRET as `0x${string}` });
    if (w.address !== treasury) throw new Error("EVM_TREASURY_ADDRESS does not match EVM_TREASURY_SECRET");
    treasurySigner = makeEvmTreasurySigner(w.client, { usdc: env.EVM_USDC_ADDRESS! });
    treasurySignerAddress = w.address;
  }
  return {
    treasury, source, deposits,
    makeConfirmer: (store: import("../services/deposit-worker.js").DepositCursorStore) =>
      makeEvmDepositConfirmer({ deposits, source, store, treasury, pollMs: env.DEPOSIT_POLL_MS, startBlock }),
    treasurySigner, treasurySignerAddress,
    chainStatus: makeEvmChainStatusReader(pub, env.EVM_CONFIRMATIONS),
    readTreasuryBaseUnits: () => source.readTreasuryBaseUnits(),
  };
}
```

Test it with a stubbed public client (mock `makePublicClient` via vitest `vi.mock`) asserting: wrong decimals throws; secret/address mismatch throws; correct components returned.

- [ ] **Step 2:** In `server/src/index.ts`, inside `if (env.REAL_MONEY_ENABLED)`, branch on family. Keep the ENTIRE existing Solana block untouched inside `if (env.CHAIN_FAMILY === "solana") { ... }`. Add the EVM branch:

```ts
    if (env.CHAIN_FAMILY === "evm") {
      const { bootEvmRail } = await import("./evm/boot.js");
      const { makeDeposits } = await import("./services/deposits.js");
      const { makeDbDepositCursorStore } = await import("./services/deposit-worker.js");
      const rail = await bootEvmRail(env, { db, makeDeposits, ledger });
      if (env.RUN_CONFIRMER) { depositConfirmer = rail.makeConfirmer(makeDbDepositCursorStore(db)); depositConfirmer.start(); }
      realMoney = { enabled: true, treasuryUsdcAta: rail.treasury }; // /v1/deposit/address serves this
      // No depositTxBuilder / signedTxBroadcaster on EVM — the client sends the ERC-20 transfer
      // itself; those routes stay 404 (deposit_send_disabled), which the EVM client never calls.
      const { makeWithdrawals } = await import("./services/withdrawals.js");
      withdrawalsSvc = makeWithdrawals(db, ledger, { /* same cfg object as the solana branch */ }, rail.readTreasuryBaseUnits);
      if (rail.treasurySigner) {
        const { makeWithdrawProcessor, makeWithdrawConfirmer } = await import("./services/withdraw-worker.js");
        withdrawProcessor = makeWithdrawProcessor(db, rail.treasurySigner);
        if (env.RUN_CONFIRMER) {
          const { makeWithdrawConfirmLoop } = await import("./services/withdraw-confirm-loop.js");
          const confirmer = makeWithdrawConfirmer(db, ledger, rail.chainStatus, { staleSeconds: 600 }); // EVM: receipts can lag; no blockhash expiry
          /* same loop wiring as the solana branch */
        }
      }
      // EVM wallet USDC balance for the cashier ("wallet" line):
      walletBalanceReader = { read: async (wallet: string) => ({ wallet, balance: /* balanceOf via rail source */ 0 }) };
      // ^ match the exact WalletBalanceReader interface in services/wallet-balance.ts — read it first and
      //   implement with client.readContract balanceOf(wallet), returning cents via baseUnitsToCentsFloor.
    }
```

Read `server/src/services/wallet-balance.ts` before writing the reader — conform to its exact interface rather than the sketch above.

- [ ] **Step 3:** `npm test` (full server suite) → PASS. `npm run build` → clean.
- [ ] **Step 4: Commit** — `git commit -am "feat(server): boot the EVM rail behind CHAIN_FAMILY=evm"`

---

## Phase B — EVM wallet binding

### Task B1: server binding EVM path (EIP-191)

**Files:**
- Modify: `server/src/auth/wallet-binding.ts`, `server/src/http/routes.ts` (bind endpoints), `server/src/index.ts` (pass family)
- Test: `server/src/auth/wallet-binding.test.ts` (exists — extend)

- [ ] **Step 1: Failing tests** (generate a real fixture: with viem installed, `privateKeyToAccount("0x…").signMessage({ message })`):

```ts
import { privateKeyToAccount } from "viem/accounts";

describe("evm family", () => {
  const key = ("0x" + "7".repeat(64)) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const binding = createWalletBinding({ secret: "s".repeat(32), family: "evm" });

  it("binds a wallet via personal_sign", async () => {
    const c = binding.createChallenge({ userId: "u1", wallet: account.address });
    const signature = await account.signMessage({ message: c.message });
    const out = await binding.verifyChallenge({ challenge: c.challenge, signature });
    expect(out).toEqual({ userId: "u1", wallet: account.address.toLowerCase() });
  });
  it("rejects a Solana-shaped address", () => {
    expect(() => binding.createChallenge({ userId: "u1", wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" })).toThrow("invalid_wallet_address");
  });
  it("rejects a signature from a different key", async () => {
    const other = privateKeyToAccount(("0x" + "8".repeat(64)) as `0x${string}`);
    const c = binding.createChallenge({ userId: "u1", wallet: account.address });
    const signature = await other.signMessage({ message: c.message });
    expect(await binding.verifyChallenge({ challenge: c.challenge, signature })).toBeNull();
  });
});
it("solana family still verifies ed25519/base58 (existing tests untouched)", () => { /* keep existing suite green */ });
```

- [ ] **Step 2:** run → FAIL (`family` not a dep; `signature` not accepted).
- [ ] **Step 3: Implement** in `wallet-binding.ts`:
  - Deps gain `family?: "solana" | "evm"` (default `"solana"` so existing constructions/tests hold).
  - `const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;` — `createChallenge` validates per family and lowercases EVM addresses before building the message (`wallet: family === "evm" ? wallet.toLowerCase() : wallet`).
  - `verifyChallenge` input becomes `{ challenge: string; signature?: string; signatureBase58?: string }` (accept both names; `signature` preferred). EVM branch:

```ts
      if (family === "evm") {
        if (!EVM_ADDRESS_RE.test(payload.wallet)) return null;
        const sig = input.signature ?? input.signatureBase58 ?? "";
        if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
        const { verifyMessage } = await import("viem");
        const ok = await verifyMessage({ address: payload.wallet as `0x${string}`, message: payload.message, signature: sig as `0x${string}` });
        return ok ? { userId: payload.userId, wallet: payload.wallet.toLowerCase() } : null;
      }
```

  - Solana branch: unchanged (reads `input.signatureBase58 ?? input.signature`).
- [ ] **Step 4:** Update the `/v1/wallet/bind` route's zod schema in `routes.ts` to accept `signature` OR `signatureBase58` (both optional strings, at least one required) and pass both through. Update `index.ts`: `createWalletBinding({ secret: ..., family: env.CHAIN_FAMILY })`.
- [ ] **Step 5:** Also fix `server/src/scripts/bind-wallet.ts`: validate the address against the family regex (read `CHAIN_FAMILY` from env; refuse anything matching neither).
- [ ] **Step 6:** `npm test -- wallet-binding && npm test` → PASS.
- [ ] **Step 7: Commit** — `git commit -am "feat(server): EIP-191 wallet binding behind CHAIN_FAMILY"`

---

## Phase C — server-handled feed

### Task C1: feed symbol config module

**Files:**
- Create: `server/src/feed/symbols.ts`
- Modify: `server/src/feed/hermes.ts` (import table instead of local `FEED_IDS`)
- Test: `server/src/feed/symbols.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, expect, it } from "vitest";
import { FEED_SYMBOLS, hermesIdOf, feedAssetKeys } from "./symbols.js";

describe("feed symbols", () => {
  it("carries the launch crypto set", () => {
    expect(feedAssetKeys()).toEqual(["BTC", "ETH", "SOL"]);
    expect(hermesIdOf("BTC")).toBe("e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43");
  });
  it("every entry has a 64-hex hermes id (equities later just add rows)", () => {
    for (const s of Object.values(FEED_SYMBOLS)) expect(s.hermesId).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2:** Implement `symbols.ts` (move the three ids from `hermes.ts:8-12` verbatim; shape `{ hermesId: string; display: string }`; export `feedAssetKeys()` / `hermesIdOf(key)`). Point `hermes.ts` at it (delete its local `FEED_IDS`; `const FEED_IDS = Object.fromEntries(Object.entries(FEED_SYMBOLS).map(([k, v]) => [k, v.hermesId]))` keeps the diff minimal). `index.ts`: `assets: feedAssetKeys()`.
- [ ] **Step 3:** `npm test -- feed` → PASS (hermes tests untouched). Commit — `git commit -am "refactor(server): feed symbol table as config (equities = add a row)"`

### Task C2: `/v1/feed` WebSocket fan-out

**Files:**
- Create: `server/src/feed/socket.ts`
- Modify: `server/src/http/server.ts` (register, next to the presence socket registration)
- Test: `server/src/feed/socket.test.ts`

- [ ] **Step 1: Failing test** (drive the broadcast loop with fakes — no real ws needed):

```ts
import { describe, expect, it } from "vitest";
import { makeFeedBroadcaster } from "./socket.js";

const fakeFeed = (price: number, tsUs: number, healthy = true) => ({
  current: () => ({ price, tsUs }),
  healthy: () => healthy,
});

describe("makeFeedBroadcaster", () => {
  it("broadcasts a tick per asset only when publish_time advances", () => {
    const sent: string[] = [];
    const feed = { current: (a: string) => ({ price: a === "BTC" ? 50000 : 3000, tsUs: 111 }), healthy: () => true };
    const b = makeFeedBroadcaster({ feed: feed as never, assets: ["BTC", "ETH"], send: (msg) => sent.push(msg) });
    b.pump();
    expect(sent.map((s) => JSON.parse(s).symbol).sort()).toEqual(["BTC", "ETH"]);
    b.pump(); // same tsUs → nothing new
    expect(sent.length).toBe(2);
  });
  it("skips unhealthy assets and marks them stale once", () => {
    const sent: string[] = [];
    const b = makeFeedBroadcaster({ feed: fakeFeed(1, 1, false) as never, assets: ["BTC"], send: (m) => sent.push(m) });
    b.pump();
    expect(JSON.parse(sent[0])).toEqual({ type: "stale", symbol: "BTC" });
  });
});
```

- [ ] **Step 2: Implement** `server/src/feed/socket.ts`:

```ts
import type { PriceFeed } from "./types.js";

/** Pure per-pump diffing: one JSON message per asset whose publish_time advanced. */
export function makeFeedBroadcaster(deps: { feed: PriceFeed; assets: string[]; send: (msg: string) => void }) {
  const lastTs: Record<string, number> = {};
  const staleSent: Record<string, boolean> = {};
  return {
    pump() {
      for (const symbol of deps.assets) {
        if (!deps.feed.healthy(symbol)) {
          if (!staleSent[symbol]) { staleSent[symbol] = true; deps.send(JSON.stringify({ type: "stale", symbol })); }
          continue;
        }
        staleSent[symbol] = false;
        let tick; try { tick = deps.feed.current(symbol); } catch { continue; }
        if (lastTs[symbol] === tick.tsUs) continue;
        lastTs[symbol] = tick.tsUs;
        deps.send(JSON.stringify({ type: "tick", symbol, price: tick.price, tsUs: tick.tsUs }));
      }
    },
  };
}

/** Fastify route: every client gets the full current snapshot on connect, then shared pumped ticks. */
export function registerFeedSocket(server: unknown, deps: { feed: PriceFeed; assets: string[]; intervalMs?: number }) {
  const sockets = new Set<{ send(m: string): void; readyState: number }>();
  const b = makeFeedBroadcaster({ ...deps, send: (msg) => { for (const s of sockets) if (s.readyState === 1) { try { s.send(msg); } catch { /* slow client: drop */ } } } });
  const timer = setInterval(() => b.pump(), deps.intervalMs ?? 250);
  (server as { get(p: string, o: object, h: (s: { send(m: string): void; readyState: number; on(e: string, f: () => void): void }) => void }).get(
    "/v1/feed", { websocket: true }, (socket) => {
      sockets.add(socket);
      for (const symbol of deps.assets) { try { const t = deps.feed.current(symbol); socket.send(JSON.stringify({ type: "tick", symbol, price: t.price, tsUs: t.tsUs })); } catch { /* no tick yet */ } }
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 3:** Register in `buildServer` (`server/src/http/server.ts`) exactly where/how the presence socket registers (read `server/src/presence/socket.ts:162-188` for the registrar cast pattern; `buildServer` already receives `feed` in its deps): `registerFeedSocket(server, { feed: deps.feed, assets: ["BTC", "ETH", "SOL"] })` — pass the asset list from `feedAssetKeys()` through deps rather than re-hardcoding.
- [ ] **Step 4:** `npm test -- feed && npm run build` → PASS. Commit — `git commit -am "feat(server): /v1/feed WS price fan-out"`

### Task C3: client feed rewrite — server WS primary, `/v1/prices` fallback, Pyth key GONE

**Files:**
- Rewrite: `redline3d/src/core/feed.ts`
- Modify: `redline3d/src/main.ts:336-352` (ASSETS + connect), `redline3d/Dockerfile` (drop `VITE_PYTH_API_KEY` ARG), `redline3d/.env.development` + `.env.production` (drop the var if present), `redline3d/src/core/deployment-env.test.ts` (parity assertions)
- Test: `redline3d/src/core/feed.test.ts` (exists — rewrite alongside)

- [ ] **Step 1: New tests** (replace Lazer/Hermes cases):

```ts
import { describe, expect, it, vi } from "vitest";
import { connectFeed, feedWsUrl } from "./feed";

describe("feedWsUrl", () => {
  it("derives ws(s) from the API base", () => {
    expect(feedWsUrl("https://api.example.com")).toBe("wss://api.example.com/v1/feed");
    expect(feedWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/v1/feed");
  });
});

describe("connectFeed", () => {
  it("emits prices from server WS ticks", () => {
    const sockets: FakeWs[] = [];
    class FakeWs { onmessage: ((e: { data: string }) => void) | null = null; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; readyState = 1; constructor(public url: string) { sockets.push(this); } close() {} }
    const prices: Array<[string, number]> = [];
    const h = connectFeed({ feeds: [{ key: "BTC" }], onPrice: (k, v) => prices.push([k, v]), wsCtor: FakeWs as never, apiBase: "http://x" });
    sockets[0].onmessage!({ data: JSON.stringify({ type: "tick", symbol: "BTC", price: 50000, tsUs: 1 }) });
    expect(prices).toEqual([["BTC", 50000]]);
    h.stop();
  });
  it("contains no Pyth endpoints or tokens", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("./feed.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/dourolabs|hermes\.pyth|LAZER|ACCESS_TOKEN|H3BPYYS/);
  });
});
```

- [ ] **Step 2:** run → FAIL. **Step 3: Rewrite `feed.ts`** keeping the public surface main.ts uses (`FeedSpec` — now just `{ key: string }`; `FeedStatus`; `FeedOpts` + optional `wsCtor` / `apiBase` injection for tests; `FeedHandle`; `connectFeed`; `config()`):
  - `feedWsUrl(apiBase)`: `apiBase.replace(/\/$/, "").replace(/^http/, "ws") + "/v1/feed"`.
  - Primary: `new WebSocket(feedWsUrl(...))`; `tick` messages → `emit(symbol, price, tsUs)`; `stale` messages → mark not-live. Reconnect with capped backoff (400ms → 4s) on close/error.
  - Fallback: while no WS message for >1200ms, poll `/v1/prices` every 600ms (port the existing `apiPollOnce` body verbatim, including the `viteApiPricesUrl()` helper).
  - Keep the rate/status heartbeat block (`statusTimer`) as-is with labels `"Slopwheels feed · N/s"`.
  - DELETE: `LAZER_TOKEN`, `ENDPOINTS`, `openLazer`/`onLazerDown`, `HERMES_*`, `resolveHermesToken`, `authorizeHermes`, `vitePythKey`, the `?lazer/?hermes` param handling. (Two exported helpers — `resolveHermesToken`/`authorizeHermes` — die with their tests.)
- [ ] **Step 4:** `main.ts`: shrink `ASSETS` (line 336) to `[{ key: "BTC" }, { key: "ETH" }, { key: "SOL" }]` — delete the `lz`/`hx`/`expo` fields. The `connectFeed` callsite (343-351) is otherwise unchanged.
- [ ] **Step 5:** `redline3d/Dockerfile`: remove the `VITE_PYTH_API_KEY` ARG/ENV lines. Run `npm test -- deployment-env` and fix its parity assertions to expect the var's ABSENCE everywhere (it `?raw`-imports Dockerfile + env files — update deliberately, per its design).
- [ ] **Step 6:** `cd redline3d && npm test -- feed && npm test -- deployment-env && npx tsc --noEmit` → PASS. Grep-proof: `grep -RniE "dourolabs|hermes.pyth|H3BPYYS" redline3d/src` → empty.
- [ ] **Step 7: Commit** — `git commit -am "feat(client): server-fed prices over /v1/feed WS; Pyth key and Lazer client removed"`

---

## Phase D — autonomous cash settler

### Task D1: settler service

**Files:**
- Create: `server/src/services/round-settler.ts`
- Test: `server/src/services/round-settler.test.ts`

The engine settles at whatever exit marks it is handed; `rounds.mark()` computes the CURRENT outcome (`"cashout" | "liq" | "cap" | "time"`) and primes the shown-mark cache that `close()` settles at. So the settler is: sweep open rounds → `mark()` → any non-`"cashout"` outcome means a terminal condition has fired → `close(userId, id, "expire")` (reason is telemetry; the outcome is server-derived).

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it } from "vitest";
import { makeRoundSettler } from "./round-settler.js";

function fixtures() {
  const closed: string[] = [];
  const rounds = {
    mark: async (_u: string, id: string) => ({ status: "open", stale: false, outcome: id === "r-liq" ? "liq" : "cashout", equity: 1, payoutCoins: 0, buffer: 1 }),
    close: async (_u: string, id: string) => { closed.push(id); return {} as never; },
  };
  const listOpen = async () => [
    { id: "r-liq", userId: "u1" },
    { id: "r-fine", userId: "u2" },
  ];
  return { rounds, listOpen, closed };
}

describe("makeRoundSettler", () => {
  it("closes rounds whose mark outcome is terminal, leaves healthy rounds open", async () => {
    const f = fixtures();
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.closed).toEqual(["r-liq"]);
  });
  it("a FeedHalt on one round does not stop the sweep", async () => {
    const f = fixtures();
    f.rounds.mark = async (_u, id) => { if (id === "r-liq") throw new Error("feed_halt"); return { status: "open", stale: false, outcome: "liq", equity: 0, payoutCoins: 0, buffer: 0 }; };
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.closed).toEqual(["r-fine"]); // r-liq skipped (halted), r-fine's terminal mark closed
  });
  it("a stale mark never triggers a close", async () => {
    const f = fixtures();
    f.rounds.mark = async () => ({ status: "open", stale: true, outcome: null, equity: 1, payoutCoins: 0, buffer: 1 });
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.closed).toEqual([]);
  });
});
```

- [ ] **Step 2:** run → FAIL. **Step 3: Implement:**

```ts
import type { Rounds } from "./rounds.js";
import type { RoundSettler } from "./round-settler-guard.js";

export interface RoundSettlerOpts {
  rounds: Pick<Rounds, "mark" | "close">;
  /** every open round (id + owner); index-friendly: `where status = 'open'`. */
  listOpen: () => Promise<Array<{ id: string; userId: string }>>;
  pollMs: number;
  onError?: (roundId: string, error: unknown) => void;
}

/**
 * Autonomous cash settler (closes the free-option hole round-settler-guard documents):
 * every tick, mark() each open round with the SERVER feed and force-close any round whose
 * outcome is terminal (liq / cap / time). mark() primes the shown-mark cache, so the close
 * settles at exactly the evaluated mark. Client closes race safely: rounds.close is
 * advisory-locked + idempotent, so double-close returns the stored result.
 */
export function makeRoundSettler(opts: RoundSettlerOpts): RoundSettler & { tick(): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  async function tick(): Promise<void> {
    for (const r of await opts.listOpen()) {
      try {
        const m = await opts.rounds.mark(r.userId, r.id);
        if (m.status !== "open" || m.stale || m.outcome === "cashout" || m.outcome === null) continue;
        await opts.rounds.close(r.userId, r.id, "expire");
      } catch (e) { opts.onError?.(r.id, e); } // halt/transient: retry next tick, keep sweeping
    }
  }
  return {
    tick,
    start() { void tick().catch(() => {}); timer = setInterval(() => void tick().catch(() => {}), opts.pollMs); },
    stop() { if (timer) clearInterval(timer); },
  };
}
```

- [ ] **Step 4:** `npm test -- round-settler` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): autonomous round settler (liq/cap/deadline enforced server-side)"`

### Task D2: wire the settler; cash rounds can boot

**Files:**
- Modify: `server/src/index.ts:33-38`
- Modify: `server/src/env.ts` (add `ROUND_SETTLE_POLL_MS` default 1000)

- [ ] **Step 1:** Replace the hardcoded `const roundSettler: RoundSettler | null = null;` block: `makeRounds` must be constructed FIRST, then:

```ts
  const rounds = makeRounds({ db, ledger, feed, stakeAsset, houseUserId });
  const roundSettler: RoundSettler | null =
    stakeAsset === "cash"
      ? makeRoundSettler({
          rounds,
          listOpen: async () => (await db.select({ id: roundsTable.id, userId: roundsTable.userId }).from(roundsTable).where(eq(roundsTable.status, "open"))) as Array<{ id: string; userId: string }>,
          pollMs: env.ROUND_SETTLE_POLL_MS,
          onError: (id, e) => console.warn("[round_settle_failed]", id, e),
        })
      : null;
  assertRoundSettlerForStake({ stakeAsset, cashSettlerEnabled: env.CASH_SETTLER_ENABLED, roundSettler });
  roundSettler?.start();
```

(This moves the `makeRounds` call and the guard below the feed construction — reorder carefully; `feed.start()` stays before `makeRounds`. Import `rounds as roundsTable` from `./db/schema.js`. Update the guard's stale header comment to describe the now-wired settler.)
- [ ] **Step 2:** `npm test && npm run build` → PASS. Boot check: `DOTENV_CONFIG_PATH=/dev/null REAL_MONEY_ENABLED=true CASH_SETTLER_ENABLED=true CHAIN_FAMILY=evm EVM_RPC_URL=… npx tsx src/index.ts` is NOT required here (needs live RPC) — the unit suite + the guard tests cover the wiring contract.
- [ ] **Step 3: Commit** — `git commit -am "feat(server): wire the cash settler — real-money rounds can boot"`

---

## Phase E — client pivot

### Task E1: EVM chain config + wallet port (+ dev twin)

**Files:**
- Create: `redline3d/src/evm/chain.ts`, `redline3d/src/evm/wallet-port.ts`, `redline3d/src/evm/dev-evm-port.ts`
- Modify: `redline3d/package.json` (add `viem`)
- Test: `redline3d/src/evm/chain.test.ts`, `redline3d/src/evm/dev-evm-port.test.ts`

- [ ] **Step 1:** `cd redline3d && npm install viem --legacy-peer-deps` (this workspace pins `--legacy-peer-deps`; see its lockfile conventions).
- [ ] **Step 2: Failing tests.** `chain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveEvmChain } from "./chain";

describe("resolveEvmChain", () => {
  it("mainnet by default; testnet on VITE_EVM_CHAIN=testnet", () => {
    expect(resolveEvmChain({}).id).toBe(4663);
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "testnet" }).id).toBe(46630);
    expect(resolveEvmChain({}).rpcUrls.default.http[0]).toBe("https://rpc.mainnet.chain.robinhood.com");
  });
});
```

`dev-evm-port.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDevEvmPort } from "./dev-evm-port";

describe("createDevEvmPort", () => {
  it("derives a stable address and signs EIP-191", async () => {
    const port = createDevEvmPort(("0x" + "7".repeat(64)) as `0x${string}`);
    const { address } = await port.connect();
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    const sig = await port.signMessage("hello");
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });
});
```

- [ ] **Step 3: Implement.** `chain.ts`:

```ts
import { defineChain, type Chain } from "viem";

const MAINNET = { id: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" };
const TESTNET = { id: 46630, rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com" };

export function resolveEvmChain(env: { VITE_EVM_CHAIN?: string }): Chain {
  const net = env.VITE_EVM_CHAIN === "testnet" ? TESTNET : MAINNET;
  return defineChain({
    id: net.id, name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [net.rpc] } },
    blockExplorers: { default: { name: "Blockscout", url: net.explorer } },
  });
}
export const EVM_CHAIN: Chain = resolveEvmChain({ VITE_EVM_CHAIN: import.meta.env.VITE_EVM_CHAIN as string | undefined });
export const EVM_USDC = ((import.meta.env.VITE_EVM_USDC_ADDRESS as string | undefined) ?? "").toLowerCase();
```

`wallet-port.ts` — the EVM port interface (deliberately NOT `SolanaWalletPort`; message signing is string-in/hex-out here):

```ts
export interface EvmWalletPort {
  kind: "privy-evm" | "dev-evm";
  connect(): Promise<{ address: string }>;
  reconnect(): Promise<{ address: string } | null>;
  disconnect(): Promise<void>;
  currentAddress(): string | null;
  /** EIP-191 personal_sign over the UTF-8 message; resolves the 65-byte signature as 0x-hex. */
  signMessage(message: string): Promise<string>;
  /** ERC-20 USDC transfer to `to`; resolves the tx hash. */
  sendUsdcTransfer(to: string, amountBaseUnits: bigint): Promise<string>;
  /** wallet's own USDC balance in base units (cashier display), null if unreadable. */
  usdcBalance(): Promise<bigint | null>;
}
```

`dev-evm-port.ts` (viem `privateKeyToAccount` + a public client on `EVM_CHAIN` for `usdcBalance`; `sendUsdcTransfer` via `createWalletClient({ account, chain: EVM_CHAIN, transport: http() }).writeContract(...)` with `erc20Abi`; key from `VITE_DEV_EVM_SECRET`).
- [ ] **Step 4:** `npm test -- evm/ && npx tsc --noEmit` → PASS. Commit — `git commit -am "feat(client): Robinhood Chain config + EVM wallet port (dev twin)"`

### Task E2: Privy island — EVM mode

**Files:**
- Create: `redline3d/src/evm/privy-evm-island.ts` (new file; the Solana island stays parked untouched)
- Create: `redline3d/src/evm/privy-evm-port.ts`
- Test: `redline3d/src/evm/privy-evm-port.test.ts` (port logic against a fake island)

- [ ] **Step 1:** Copy `redline3d/src/chain/privy-island.ts` to `privy-evm-island.ts` and convert it (same Bridge/facade/mount pattern — keep the login-error handling, ready-timeout, and re-entry logic verbatim):
  - Imports: drop `@privy-io/react-auth/solana` entirely. Use root `usePrivy`, `useLogin`, `useWallets`, `useCreateWallet` from `@privy-io/react-auth`. **Verify each name exists in the installed v3 types first** (grep `redline3d/node_modules/@privy-io/react-auth/dist/index.d.ts`); where the root package namespaces EVM hooks differently, follow the types, not this plan.
  - Wallet pick: the embedded EVM wallet — `wallets.find((w) => w.walletClientType === "privy")` (verify the discriminator in types; fall back to the `isPrivyWallet` pattern the Solana island uses).
  - Signing/sending go through the EIP-1193 provider (stable across Privy versions): `const provider = await wallet.getEthereumProvider();`
    - `signMessage(msg)`: `provider.request({ method: "personal_sign", params: ["0x" + Buffer-hex(utf8(msg)), wallet.address] })` (hex-encode with a small local helper, no Buffer in the browser).
    - `sendUsdcTransfer(to, amount)`: `provider.request({ method: "eth_sendTransaction", params: [{ from: wallet.address, to: EVM_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) }] })` (viem's `encodeFunctionData` is fine client-side).
    - Chain pinning: `PrivyProvider` config gets `supportedChains: [EVM_CHAIN], defaultChain: EVM_CHAIN`; before the first send, `provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + EVM_CHAIN.id.toString(16) }] })`.
  - Config: `embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false }` (again: verify the exact key — v3 types are authoritative).
- [ ] **Step 2:** `privy-evm-port.ts` — adapts the island facade to `EvmWalletPort` with the same lazy-mount pattern as `createLazyPrivyPort` (`redline3d/src/chain/wallet-select.ts:54-95`), including the `privy:` localStorage probe for silent `reconnect()`. `usdcBalance()` reads via a viem public client on `EVM_CHAIN` (`readContract balanceOf`).
- [ ] **Step 3: Test** the port with a fake island (connect resolves address; signMessage returns `0x…130`; lazy mount only on first connect; reconnect without persisted session resolves null WITHOUT mounting).
- [ ] **Step 4:** `npm test -- privy-evm && npx tsc --noEmit` → PASS. Commit — `git commit -am "feat(client): Privy EVM island + port on Robinhood Chain"`

### Task E3: rail selection + EVM binding on the client

**Files:**
- Create: `redline3d/src/evm/rail.ts`
- Modify: `redline3d/src/core/wallet-binding.ts` (EVM path)
- Delete: `redline3d/src/core/appsigner.ts` + `appsigner.test.ts` (dead code — signing methods always reject; live path never referenced it)
- Test: `redline3d/src/evm/rail.test.ts`, extend `redline3d/src/core/wallet-binding.test.ts`

- [ ] **Step 1:** `rail.ts`:

```ts
export type ChainRail = "evm" | "solana";
export function resolveChainRail(env: { VITE_CHAIN_RAIL?: string }, search: string): ChainRail {
  const p = new URLSearchParams(search).get("rail");
  if (p === "evm" || p === "solana") return p;
  return env.VITE_CHAIN_RAIL === "solana" ? "solana" : "evm";
}
export function selectEvmWalletPort(): import("./wallet-port").EvmWalletPort { /* ?wallet=dev / VITE_WALLET=dev → dev port; else lazy privy-evm port — mirror chain/wallet-select.ts resolution order */ }
```

Test: default evm; `?rail=solana` overrides; env pin works.
- [ ] **Step 2:** `wallet-binding.ts` — add the EVM flavor next to the Solana one (keep `connectAndBindWallet` for the parked rail):

```ts
export async function connectAndBindEvmWallet(input: {
  port: Pick<import("../evm/wallet-port").EvmWalletPort, "connect" | "signMessage">;
  api: Pick<Api, "bindWalletChallenge" | "bindWallet">;
}) {
  const connected = await input.port.connect();
  const challenge = await input.api.bindWalletChallenge(connected.address);
  if (challenge.wallet.toLowerCase() !== connected.address.toLowerCase()) throw new Error("wallet_mismatch");
  const signature = await input.port.signMessage(challenge.message);
  const bound = await input.api.bindWallet({ challenge: challenge.challenge, signature });
  return { address: bound.wallet, session: bound.token && bound.userId ? { token: bound.token, userId: bound.userId } : undefined };
}
```

`api.ts`: widen `bindWallet` input to `{ challenge: string; signature?: string; signatureBase58?: string }` (server accepts both after B1). Test with fake port/api asserting the hex signature passes through under `signature`.
- [ ] **Step 3:** Delete `appsigner.ts` + its test; `grep -rn "appsigner" redline3d/src` must come back empty.
- [ ] **Step 4:** `npm test -- rail wallet-binding && npx tsc --noEmit` → PASS. Commit — `git commit -am "feat(client): chain-rail selection + EIP-191 binding; drop dead AppSigner"`

### Task E4: USD stake currency

**Files:**
- Modify: `redline3d/src/core/stake-currency.ts`
- Test: `redline3d/src/core/stake-currency.test.ts` (extend if present, else create)

- [ ] **Step 1: Failing test:**

```ts
import { describe, expect, it } from "vitest";
import { USD_STAKE_CURRENCY, ACTIVE_STAKE_CURRENCY, baseToUnits, unitsToBase } from "./stake-currency";

describe("USD stake currency", () => {
  it("base unit IS the cent (server-ledger parity)", () => {
    expect(USD_STAKE_CURRENCY.decimals).toBe(2);
    expect(USD_STAKE_CURRENCY.displayUnitDecimals).toBe(2);
    expect(unitsToBase(250, USD_STAKE_CURRENCY)).toBe(250);   // display units == cents
    expect(baseToUnits(250n, USD_STAKE_CURRENCY)).toBe(250);
  });
  it("USD is the active currency on the evm rail", () => {
    expect(ACTIVE_STAKE_CURRENCY.key).toBe("USD");
  });
});
```

- [ ] **Step 2: Implement:** widen `StakeCurrencyKey` to `"SOL" | "USD"`; add:

```ts
export const USD_STAKE_CURRENCY: StakeCurrency = Object.freeze({
  key: "USD", symbol: "USD", mint: "", decimals: 2, displayUnitDecimals: 2,
  fundingMode: "spl-transfer", initialBuyInBase: 0,
});
export const SOL_STAKE_CURRENCY = /* the old ACTIVE object, frozen, unchanged */;
export const ACTIVE_STAKE_CURRENCY: StakeCurrency = USD_STAKE_CURRENCY; // evm rail; the parked solana harness imports SOL_STAKE_CURRENCY explicitly
```

Sweep compile fallout: `grep -rn "ACTIVE_STAKE_CURRENCY" redline3d/src` — display sites divide by `10 ** displayUnitDecimals` (now dollars) which stays correct; fix any site that hardcoded SOL specifics (the wallet UI is rebuilt next task; `main.ts` money math is rebuilt in E6).
- [ ] **Step 3:** `npm test -- stake-currency && npx tsc --noEmit` → PASS (tsc fallout in wallet/main gets `// @ts-expect-error` ONLY if the fixing task is E5/E6 — prefer fixing forward-compatible sites now).
- [ ] **Step 4: Commit** — `git commit -am "feat(client): USD stake currency (cent base units) active on the evm rail"`

### Task E5: cashier rebuild — server balance, USDC deposit, withdraw

**Files:**
- Modify: `redline3d/src/ui/wallet.ts`, `redline3d/src/core/api.ts`
- Test: `redline3d/src/ui/wallet.test.ts` (exists — extend/adjust)

- [ ] **Step 1:** `api.ts` — add the withdraw method next to `walletBalance` (route exists: `POST /v1/withdraw`):

```ts
  withdraw(p: { amountCents: number }): Promise<{ id: string; status: string; amountCents: number }>;
  // impl: withdraw: (p) => call("POST", "/v1/withdraw", p),
```

(Read the route's actual request/response shape at `server/src/http/routes.ts:441-456` first and mirror it exactly — including the dest-wallet semantics: server pays to the BOUND wallet; the client never posts an address.)
- [ ] **Step 2:** Rework `WalletOpts` (`redline3d/src/ui/wallet.ts:22-47`):

```ts
export interface WalletOpts {
  currency?: StakeCurrency;
  /** the bound EVM wallet address (Privy embedded) — funding target for bridged USDC + gas. */
  address: () => string;
  /** server ledger cash balance in cents. */
  balance: () => number;
  /** wallet's own USDC (base units) — shows a deposit arriving before it is moved in. */
  fetchWalletUsdc?: () => Promise<bigint | null>;
  deposit: {
    minCents: number; maxCents: number;
    /** ERC-20 transfer from the embedded wallet to the treasury; resolves the tx hash. */
    send: (amountCents: number) => Promise<string>;
  };
  withdraw: { minCents: number; maxCents: number; request: (amountCents: number) => Promise<void> };
}
```

UI (keep the existing synthwave shell/styles; replace the SOL QR flow):
  - Hero: server cash balance in dollars; sub-line `Robinhood Chain · wallet <USDC> USDC` from `fetchWalletUsdc`.
  - **Add funds:** amount stepper (min/max from opts) + `Deposit` button → `deposit.send(cents)` → status `Deposit sent — it lands after N confirmations` and re-poll balance; below it the QR + copy of the PLAYER's own wallet address labeled `Fund this wallet with USDC on Robinhood Chain (plus a little ETH for gas)`.
  - **Cash out:** amount stepper + button → `withdraw.request(cents)` → status `Withdrawal requested — arrives after review.` (the admin-approve + hold flow is server policy; the copy stays honest about the delay).
  - `delegated` disappears from this file entirely.
- [ ] **Step 3:** Update `wallet.test.ts`: deposit button calls `deposit.send` with the stepper's cents; withdraw respects min/max; balance renders dollars; NO reference to `onchain.status`/`delegated` remains (`grep -n "delegated" redline3d/src/ui/wallet.ts` → empty).
- [ ] **Step 4:** `npm test -- ui/wallet && npx tsc --noEmit` → PASS (main.ts callsite fixed next task — if tsc blocks, land E5+E6 as one commit instead of forcing a broken interim).
- [ ] **Step 5: Commit** — `git commit -am "feat(client): cashier speaks server ledger + Robinhood Chain USDC"`

### Task E6: server-session adapter + main.ts rebind (the big one)

**Files:**
- Create: `redline3d/src/core/server-session.ts`
- Modify: `redline3d/src/main.ts` (every `session.` call site — the authoritative list is `grep -n "session\." redline3d/src/main.ts`)
- Test: `redline3d/src/core/server-session.test.ts`

- [ ] **Step 1:** Build the adapter against the EXISTING server API (`redline3d/src/core/api.ts` round methods + `round-sync.ts` coalescer/queue — finally wiring the module that until now only tests used):

```ts
import type { Api, Asset, Dir } from "./api";
import { createCoalescer, createActionQueue, type Coalescer, type ActionQueue } from "./round-sync";
import type { EvmWalletPort } from "../evm/wallet-port";

/** The surface main.ts consumes (the ER game-session's role, server-authoritative). */
export interface ServerSession {
  init(): Promise<void>;
  loginFresh(): Promise<void>;
  reconnect(): Promise<boolean>;
  logout(): Promise<void>;
  address(): string;
  signMessage(m: Uint8Array): Promise<Uint8Array>;
  /** server cash balance in cents (bigint for call-site compatibility with baseToUnits). */
  balance(): bigint;
  refreshBalance(): Promise<void>;
  walletUsdc(): Promise<bigint | null>;
  open(asset: Asset, dir: Dir, lev: number, stakeCents: number): Promise<{ roundId: string }>;
  flip(dir: Dir): Promise<void>;
  noteLeverage(lev: number): void;
  pump(nowMs: number): void; // forward to the coalescer (main's rAF loop calls this)
  poll(): Promise<{ status: "open" | "settled"; equity: number; payoutCoins: number; outcome: string | null; buffer: number; stale: boolean } | null>;
  close(): Promise<{ outcome: string; payoutCoins: number; pnlCoins: number; equity: number; balance: number }>;
  withdraw(amountCents: number): Promise<void>;
  liveRoundId(): string | null;
  // ── compatibility shims for call sites the ER concept owned ──
  delegated(): boolean;          // always false — no ER
  crankArmed(): boolean;         // always true — the server settler is always on
  endSession(): Promise<void>;   // no-op
  tableLimit(): Promise<bigint | null>; // null — server caps stakes at open()
}
```

Implementation notes (write real bodies, TDD each):
  - Auth/identity: constructor deps `{ api: Api; port: EvmWalletPort; bind: typeof connectAndBindEvmWallet }`. `loginFresh` = port.connect → bind → store session (mirror how `sign-in-sync.ts` + `main.ts:275-282` do it today — read those sites first). `signMessage(m)` adapts the port's string signer: `hexToBytes(await port.signMessage(new TextDecoder().decode(m)))`.
  - `open`: `api.openRound(...)` (existing method — check its exact name/shape in api.ts) then wire the coalescer (`createCoalescer({ windowMs: 350, emit: (lev) => queue.enqueue({ actionId: crypto.randomUUID(), kind: "lever", lev }) })`) and queue (`createActionQueue({ send: (a) => api.roundAction(roundId, a), maxRetries: 3, retryDelayMs: 400 })`).
  - `flip`: enqueue a flip action. `close`: `queue.drain()` then `api.closeRound(roundId, "cashout")`; refresh balance from the result. `poll`: `api.roundMark(roundId)`.
  - `withdraw`: `api.withdraw({ amountCents })`.
  - Tests: fake `Api` + fake port; assert open→lever-coalesce→close drains the queue before closing; `delegated()` false; `close` idempotent passthrough.
- [ ] **Step 2:** Rebind `main.ts`. The construction site (find `createGameSession` / `session =` near the top) becomes rail-gated: at `evm` (default) construct `createServerSession(...)`; the ER import must become dynamic-and-dead (`if (rail === "solana") { const { createGameSession } = await import("./chain/game-session"); ... }`) so `chain/` stays out of the evm bundle. Then walk EVERY `session.` call site from the grep list; the key edits:
  - `main.ts:545` cashier opts → new E5 shape: `balance: () => Number(session.balance())`, `deposit.send: (cents) => port.sendUsdcTransfer(treasuryAddress, BigInt(cents) * 10_000n)` (treasury from `GET /v1/deposit/address` once at sign-in), `withdraw.request: (cents) => session.withdraw(cents)`.
  - `main.ts:549-555` cashOut → gone (E5 owns withdraw UX); delete the `session.endSession()` undelegate step.
  - `main.ts:1821/1855/1889-1915` GO path: replace `session.ensureSession(...)` + pot checks with plain `session.open(asset, dir, lev, stakeCents)`; the `6005`/table-rebuild/`delegate_busy` retry ladder dies (server errors surface as ApiError codes: `insufficient_balance`, `round_already_open`, `feed_halt` — map to the HUD statuses that exist for them).
  - `main.ts:2405-2408` poll gate: `if (!roundActive || settling || polling) return;` (drop `session.delegated()`), poll via `session.poll()`.
  - `main.ts:1593-1627` highway-restore path is ER-specific (round PDAs): gate it to the solana rail (wrap in `if (rail === "solana")`).
  - `main.ts:598-604` tableLimit sync: keep calling — adapter returns null → cap logic keeps last (existing behavior for null).
  - `main.ts:779-802` `session.anchorWallet()` (crate VRF): removed in E7 — leave a TODO marker this task, E7 lands within the same PR series.
- [ ] **Step 3:** `npm test && npx tsc --noEmit && npm run build` → PASS/clean. Then bundle-purity proof: `grep -RniE "@coral-xyz/anchor|@solana/web3" dist/assets/*.js | head` after `npm run build` → the main entry chunk must be clean (Anchor may exist only in the lazily-imported solana-rail chunk).
- [ ] **Step 4: Commit** — `git commit -am "feat(client): server-authoritative money loop — ER session replaced by /v1/round adapter"`

### Task E7: crates — server commit-reveal

**Files:**
- Create: `server/src/services/crate-roll.ts`, migration for `crate_commits` (drizzle: `npm run db:generate`)
- Modify: `server/src/services/crate-open.ts`, `server/src/http/routes.ts` (`/v1/crates/commit` + `/v1/crates/open`), `server/src/db/schema.ts`
- Modify: `redline3d/src/ui/cratebox.ts`, `redline3d/src/core/crate.ts`, `redline3d/src/core/api.ts`
- Test: `server/src/services/crate-roll.test.ts`, extend crate route/service tests, client crate tests

- [ ] **Step 1 (server): failing tests:**

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { drawsFromSeed, makeCrateRoll } from "./crate-roll.js";

describe("drawsFromSeed", () => {
  it("is deterministic, uniform-ish in [0,1), and matches the published derivation", () => {
    const seed = Buffer.alloc(32, 7);
    const a = drawsFromSeed(seed, 3);
    expect(a).toEqual(drawsFromSeed(seed, 3));
    for (const d of a) { expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThan(1); }
    const h = createHash("sha256").update(seed).update(Buffer.from([0])).digest();
    expect(a[0]).toBeCloseTo(h.readUInt32BE(0) / 2 ** 32, 12);
  });
});

describe("makeCrateRoll", () => {
  it("commit → open reveals a seed matching the commitment; a commit is single-use", async () => {
    const svc = makeCrateRoll(db); // reuse the test-db helper the sibling service tests use
    const c = await svc.commit("user-1");
    expect(c.commitment).toMatch(/^[0-9a-f]{64}$/);
    const opened = await svc.consume("user-1", c.commitId, 3);
    const check = createHash("sha256").update(Buffer.from(opened.seedHex, "hex")).update(Buffer.from(opened.nonceHex, "hex")).digest("hex");
    expect(check).toBe(c.commitment);
    expect(opened.draws).toHaveLength(3);
    await expect(svc.consume("user-1", c.commitId, 3)).rejects.toThrow("commit_used");
    await expect(svc.consume("user-2", c.commitId, 3)).rejects.toThrow("commit_not_found");
  });
});
```

- [ ] **Step 2: Implement** `crate-roll.ts` (schema row: `crateCommits { id uuid pk, userId, seedHex, nonceHex, commitmentHex, usedAt timestamp null, createdAt }`):

```ts
export function drawsFromSeed(seed: Uint8Array, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    createHash("sha256").update(seed).update(Buffer.from([i])).digest().readUInt32BE(0) / 2 ** 32);
}
// commit(): seed=randomBytes(32), nonce=randomBytes(16), commitment=sha256(seed‖nonce) hex → insert row, return {commitId, commitment}
// consume(userId, commitId, n): single-shot conditional update usedAt IS NULL → used (mirror withdraw-worker's claim pattern); wrong user / missing → commit_not_found; already used → commit_used. Returns { draws, seedHex, nonceHex }.
```

- [ ] **Step 3:** Routes: `POST /v1/crates/commit` (requireWalletBoundUser) → `{ commitId, commitment }`. `/v1/crates/open` body gains `commitId`; handler resolves draws server-side via `crateRoll.consume` and passes them into `crateOpen.open` in place of the client-supplied VRF draws (read `crate-open.ts` to see where draws/vrfBytes enter today and swap the source; the response gains `reveal: { seedHex, nonceHex, commitment }`). Solana-VRF fields stay accepted behind `CHAIN_FAMILY=solana`.
- [ ] **Step 4 (client):** `api.ts`: add `crateCommit(): Promise<{ commitId: string; commitment: string }>` and extend `openCrate` input/result. `cratebox.ts`: the `vrfDraws`/`vrfRoll` provider slot gets a new implementation — `commit → show commitment in the reveal UI → open(commitId) → verify sha256(seed‖nonce) === commitment locally (crate.ts helper, TDD) → badge "✓ provably fair"`; the `⛓ MagicBlock VRF` badge and `vrfRequired` Solana plumbing go behind the rail flag. Client verification failure = show `verification failed` state (never silently accept).
- [ ] **Step 5:** `cd server && npm test -- crate && cd ../redline3d && npm test -- crate && npx tsc --noEmit` → PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat: commit-reveal crate rolls (server-proven randomness, client-verified)"`

### Task E8: env/deploy config truth

**Files:**
- Modify: `redline3d/.env.development`, `redline3d/.env.production`, `redline3d/Dockerfile`, `redline3d/src/core/deployment-env.test.ts`
- Modify: `server/.env.example` if present (else create) — document the EVM var set

- [ ] **Step 1:** Client env files gain: `VITE_CHAIN_RAIL=evm`, `VITE_EVM_CHAIN=testnet` (development) / `mainnet` (production), `VITE_EVM_USDC_ADDRESS=` (filled at deploy). Dockerfile ARGs updated to match. `deployment-env.test.ts` updated to assert the new parity set (and the continued ABSENCE of `VITE_PYTH_API_KEY`).
- [ ] **Step 2:** `npm test -- deployment-env` → PASS. Commit — `git commit -am "chore: deployment env truth for the evm rail"`

---

## Phase F — verification & mainnet gate

### Task F1: full-suite + purity proof

- [ ] `cd server && npm test && npm run build` → all green.
- [ ] `cd redline3d && npm test && npm run build` → all green (build includes tsc).
- [ ] `cd packages/engine && npm test` → green.
- [ ] Purity greps (all must be EMPTY):
  - `grep -RniE "dourolabs|hermes\.pyth|H3BPYYS" redline3d/src redline3d/dist`
  - `grep -n "VITE_PYTH_API_KEY" redline3d/Dockerfile redline3d/.env.development redline3d/.env.production`
  - main entry chunk free of Anchor/web3.js (per E6 step 3).
- [ ] Live browser check (standing rule — tests are not "works"): `npm run dev` against a locally booted server (`DOTENV_CONFIG_PATH=/dev/null` + dev env: `REAL_MONEY_ENABLED` off) — game boots, prices tick from `/v1/feed` (verify in the network tab: ONE ws connection, zero requests to pyth domains), coin rounds play.
- [ ] Commit any fixes; then `git commit --allow-empty -m "chore: phase F1 verification checkpoint"`.

### Task F2: testnet e2e (chain id 46630) — with the user

Prereqs the user provides/approves: a Privy app configured for EVM embedded wallets; testnet ETH + USDC-test (bridge/faucet); a fresh testnet treasury key.

- [ ] Boot server: `CHAIN_FAMILY=evm REAL_MONEY_ENABLED=true CASH_SETTLER_ENABLED=true EVM_RPC_URL=https://rpc.testnet.chain.robinhood.com EVM_CHAIN_ID=46630 EVM_USDC_ADDRESS=<router-resolved testnet USDC> EVM_TREASURY_ADDRESS=… EVM_TREASURY_SECRET=… ADMIN_API_SECRET=…` (+ db/session vars). Never point this boot at the production `server/.env` (it is mainnet — the standing `DOTENV_CONFIG_PATH=/dev/null` rule applies).
- [ ] E2E, each PROVEN on the explorer + in the ledger to the cent: deposit lands & credits → cash round opens, settler force-closes a liq → withdraw reserve → admin approve → USDC arrives at the bound wallet → confirmer marks `confirmed`. Crate pull verifies commit-reveal in the UI.
- [ ] Record results in `docs/superpowers/specs/2026-09-01-robinhood-mainnet-design.md` under a new "Testnet proof" heading.

### Task F3: mainnet flip (user-gated; no code)

- [ ] Resolve mainnet USDC via the L2 Gateway Router; cross-check on Blockscout.
- [ ] Fresh treasury EOA (never a dev key), funded with gas ETH; Railway env set per A1's var list; `db:migrate` release step includes the crate_commits migration; Privy app allows the production origin; user rotates the leaked Pyth key (dashboard).
- [ ] Production browser verification (same checklist as F1's live check, plus one real minimum-size deposit/withdraw round-trip).

---

## Self-review notes (already applied)

- Spec coverage: chain seam (A1/A6/E3), EVM rail (A2-A6), binding (B1/E3), feed (C1-C3), settler (D1-D2 — spec addendum: cash rounds were fail-closed pending this), Privy EVM (E2), cashier (E5), main rebind (E6), crates (E7), parked Solana (A6 solana branch untouched + E6 dynamic import + E7 rail-gated fields), env truth (E8), gates (F1-F3). $SLOP/equities/4337/vault: correctly absent.
- Type consistency: `InboundTransfer` reused as-is (A4 maps into it); `WithdrawSigner`/`ReadChainStatus`/`DepositCursorStore` ports reused; `EvmWalletPort.signMessage(string)→hex` is deliberately different from `SolanaWalletPort.signMessage(Uint8Array)→Uint8Array` — the adapter (E6 step 1) bridges.
- Known judgment calls the executor may revisit with evidence: `EVM_CONFIRMATIONS=12` default; feed pump 250ms; settler poll 1000ms; withdraw confirm stale window 600s on EVM.
