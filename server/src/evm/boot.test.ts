import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "../env.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";
import type { InboundTransfer } from "../services/deposits.js";

const USDC = "0x" + "a".repeat(40);
const TREASURY = "0x" + "b".repeat(40);
const SENDER = "0x" + "c".repeat(40);
const SECRET = ("0x" + "1".repeat(64)) as `0x${string}`;

/**
 * The rail is built from the real modules; only the RPC seam (`./client.js`) is stubbed, so these
 * tests exercise the actual deposit source / confirmer / deposits wiring rather than a mock of it.
 */
const h = vi.hoisted(() => ({
  pub: undefined as any,
  walletAddress: "" as string,
  publicCfg: undefined as any,
  walletCfg: undefined as any,
}));

vi.mock("./client.js", () => ({
  makePublicClient: (cfg: unknown) => {
    h.publicCfg = cfg;
    return h.pub;
  },
  makeTreasuryWalletClient: (cfg: unknown) => {
    h.walletCfg = cfg;
    return { client: { __treasuryWallet: true }, address: h.walletAddress };
  },
}));

// static, not dynamic: vitest hoists vi.mock above the import graph, so ./client.js is already stubbed
const { bootEvmRail } = await import("./boot.js");

type Call = Record<string, unknown> & { kind: string };

function stubClient(opts: {
  /** Called once per head read, so a test can distinguish the boot read from later scan reads. */
  head?: () => bigint;
  decimals?: number;
  balances?: Record<string, bigint>;
  logs?: unknown[];
}) {
  const calls: Call[] = [];
  return {
    calls,
    getBlockNumber: async () => (opts.head ? opts.head() : 500n),
    getLogs: async (q: Record<string, unknown>) => {
      calls.push({ kind: "getLogs", ...q });
      return opts.logs ?? [];
    },
    readContract: async (q: Record<string, unknown>) => {
      calls.push({ kind: "read", ...q });
      if (q.functionName === "decimals") return opts.decimals ?? 6;
      if (q.functionName === "balanceOf") {
        const who = String((q.args as unknown[])[0]).toLowerCase();
        return (opts.balances ?? {})[who] ?? 0n;
      }
      throw new Error(`unexpected readContract ${String(q.functionName)}`);
    },
  };
}

function evmEnv(extra: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: "postgres://x",
    REAL_MONEY_ENABLED: "true",
    CHAIN_FAMILY: "evm",
    EVM_RPC_URL: "https://rpc.example/robinhood",
    EVM_CHAIN_ID: "4663",
    // Mixed case on purpose: env.ts lowercases, and the rail must expose the lowercased form.
    EVM_USDC_ADDRESS: USDC.toUpperCase().replace("0X", "0x"),
    EVM_TREASURY_ADDRESS: TREASURY.toUpperCase().replace("0X", "0x"),
    ...extra,
  } as never);
}

/** Minimal db that only supports the quarantine insert chain makeDeposits uses. */
function quarantineDb() {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    db: {
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            inserted.push(v);
          },
        }),
      }),
    } as any,
  };
}

const inbound = (over: Partial<InboundTransfer> = {}): InboundTransfer => ({
  txSig: `0x${"9".repeat(64)}:0`,
  slot: 10,
  finalized: true,
  mint: USDC,
  tokenProgram: "erc20",
  destAta: TREASURY,
  sourceOwner: SENDER,
  amountBaseUnits: 2_000_000n, // $2.00 — inside the default 100..500 cent bounds
  ...over,
});

beforeEach(() => {
  h.pub = stubClient({});
  h.walletAddress = TREASURY;
  h.publicCfg = undefined;
  h.walletCfg = undefined;
});

describe("bootEvmRail — boot refusals", () => {
  it("refuses to boot when the configured token's on-chain decimals are not USDC's", async () => {
    h.pub = stubClient({ decimals: 18 });
    await expect(bootEvmRail(evmEnv(), { db: {} as any, ledger: {} as any })).rejects.toThrow(
      /EVM_USDC_ADDRESS/,
    );
  });

  it("refuses to boot when the treasury secret derives a different address", async () => {
    h.walletAddress = "0x" + "d".repeat(40);
    await expect(
      bootEvmRail(evmEnv({ EVM_TREASURY_SECRET: SECRET }), { db: {} as any, ledger: {} as any }),
    ).rejects.toThrow(/EVM_TREASURY_ADDRESS/);
  });

  it("refuses to boot when the EVM money vars are unset, naming the missing var", async () => {
    // REAL_MONEY_ENABLED off => env.ts does not require the vars, so the rail must guard itself.
    const bare = parseEnv({ DATABASE_URL: "postgres://x", CHAIN_FAMILY: "evm" } as never);
    await expect(bootEvmRail(bare, { db: {} as any, ledger: {} as any })).rejects.toThrow(/EVM_RPC_URL/);
  });
});

describe("bootEvmRail — components", () => {
  it("returns the lowercased treasury and builds the client from the configured chain", async () => {
    const rail = await bootEvmRail(evmEnv(), { db: {} as any, ledger: {} as any });
    expect(rail.treasury).toBe(TREASURY);
    expect(h.publicCfg).toEqual({ chainId: 4663, rpcUrl: "https://rpc.example/robinhood", rpcUrlFallback: undefined });
  });

  it("leaves the treasury signer null when no secret is configured", async () => {
    const rail = await bootEvmRail(evmEnv(), { db: {} as any, ledger: {} as any });
    expect(rail.treasurySigner).toBeNull();
    expect(h.walletCfg).toBeUndefined();
  });

  it("builds a treasury signer when the secret derives the configured treasury", async () => {
    const rail = await bootEvmRail(evmEnv({ EVM_TREASURY_SECRET: SECRET }), {
      db: {} as any,
      ledger: {} as any,
    });
    expect(rail.treasurySigner).not.toBeNull();
    expect(h.walletCfg).toEqual({ chainId: 4663, rpcUrl: "https://rpc.example/robinhood", secret: SECRET });
  });

  it("starts a fresh scan at the boot head MINUS the confirmation depth, covering the pre-boot tail", async () => {
    let reads = 0;
    // 400 at boot, then a far-ahead head so the safe window covers whatever we start from.
    h.pub = stubClient({ head: () => (reads++ === 0 ? 400n : 5_000n) });
    const rail = await bootEvmRail(evmEnv({ EVM_CONFIRMATIONS: "20" }), { db: {} as any, ledger: {} as any });
    const store = new Map<string, string>();
    const confirmer = rail.makeConfirmer({
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
    });
    await confirmer.tick();
    const scan = h.pub.calls.find((c: Call) => c.kind === "getLogs");
    // 400 - 20: a transfer mined at block 385 was below the safe head at boot and is still scanned.
    expect(scan.fromBlock).toBe(380n);
    // and the cursor is keyed by the lowercased treasury address
    expect([...store.keys()]).toEqual([TREASURY]);
  });

  it("floors the fresh-scan start at block 0 on a chain younger than the confirmation depth", async () => {
    let reads = 0;
    h.pub = stubClient({ head: () => (reads++ === 0 ? 5n : 5_000n) });
    const rail = await bootEvmRail(evmEnv({ EVM_CONFIRMATIONS: "12" }), { db: {} as any, ledger: {} as any });
    const confirmer = rail.makeConfirmer({ get: async () => undefined, set: async () => {} });
    await confirmer.tick();
    const scan = h.pub.calls.find((c: Call) => c.kind === "getLogs");
    expect(scan.fromBlock).toBe(0n); // never negative
  });

  it("caps one scan at the configured EVM_MAX_BLOCK_RANGE", async () => {
    let reads = 0;
    h.pub = stubClient({ head: () => (reads++ === 0 ? 1_000n : 500_000n) });
    const rail = await bootEvmRail(evmEnv({ EVM_CONFIRMATIONS: "20", EVM_MAX_BLOCK_RANGE: "100" }), {
      db: {} as any,
      ledger: {} as any,
    });
    const confirmer = rail.makeConfirmer({ get: async () => undefined, set: async () => {} });
    await confirmer.tick();
    const scan = h.pub.calls.find((c: Call) => c.kind === "getLogs");
    // starts at 1000 - 20 = 980 and covers exactly 100 blocks, far short of the safe head
    expect(scan.fromBlock).toBe(980n);
    expect(scan.toBlock).toBe(1_079n);
  });

  it("reads the treasury balance in base units for the withdraw solvency precheck", async () => {
    h.pub = stubClient({ balances: { [TREASURY]: 12_340_000n } });
    const rail = await bootEvmRail(evmEnv(), { db: {} as any, ledger: {} as any });
    expect(await rail.readTreasuryBaseUnits()).toBe(12_340_000n);
  });

  it("reads a wallet's USDC balance in cents, flooring dust and lowercasing the wallet", async () => {
    const wallet = "0x" + "e".repeat(40);
    h.pub = stubClient({ balances: { [wallet]: 9_450_800n } });
    const rail = await bootEvmRail(evmEnv(), { db: {} as any, ledger: {} as any });
    expect(await rail.walletUsdcCents(wallet.toUpperCase().replace("0X", "0x"))).toBe(945);
  });

  it("exposes a chain-status reader", async () => {
    const rail = await bootEvmRail(evmEnv(), { db: {} as any, ledger: {} as any });
    expect(typeof rail.chainStatus).toBe("function");
  });
});

describe("bootEvmRail — deposits wiring", () => {
  it("accepts an erc20 transfer to the configured treasury (dest, mint and label all match)", async () => {
    const { db, inserted } = quarantineDb();
    h.pub = stubClient({});
    const rail = await bootEvmRail(evmEnv(), { db, ledger: {} as any });
    // 1 base unit is sub-cent dust: reaching that check proves dest/mint/program all matched.
    const out = await rail.deposits.recordInbound(inbound({ amountBaseUnits: 1n }));
    expect(out).toEqual({ status: "quarantine", reason: "sub_cent_dust" });
    expect(inserted).toHaveLength(1);
  });

  it("quarantines a transfer carrying the Solana token-program label", async () => {
    const { db } = quarantineDb();
    const rail = await bootEvmRail(evmEnv(), { db, ledger: {} as any });
    const out = await rail.deposits.recordInbound(inbound({ tokenProgram: LEGACY_TOKEN_PROGRAM }));
    expect(out).toEqual({ status: "quarantine", reason: "wrong_program" });
  });

  it("enforces the DEPOSIT_ cent bounds", async () => {
    const { db } = quarantineDb();
    const rail = await bootEvmRail(evmEnv(), { db, ledger: {} as any });
    // 50 cents, below the default DEPOSIT_MIN_CENTS of 100
    const out = await rail.deposits.recordInbound(inbound({ amountBaseUnits: 500_000n }));
    expect(out).toEqual({ status: "quarantine", reason: "out_of_bounds" });
  });
});
