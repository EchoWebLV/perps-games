import { z } from "zod";
import "dotenv/config";

const EnvShape = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  DEV_ENDPOINTS: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SIGNUP_FAUCET: z.string().optional().transform((v) => v === "true"),
  CORS_ORIGINS: z
    .string()
    .optional()
    .default("http://localhost:3000,http://127.0.0.1:3000,http://localhost:4000,http://127.0.0.1:4000,https://localhost,capacitor://localhost"),
  START_BALANCE: z.coerce.number().int().nonnegative().default(10000), // cents → $100.00 faucet
  SESSION_SECRET: z.string().min(32).optional(),
  DEV_AUTH: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),
  REAL_MONEY_ENABLED: z.string().optional().transform((v) => v === "true"),
  // Deliberate switch that must be turned on for cash (real-money) rounds to boot. Defaults off;
  // even when on, boot still fails closed until an autonomous settler is wired (see
  // assertRoundSettlerForStake). No settler exists yet, so cash rounds cannot run.
  CASH_SETTLER_ENABLED: z.string().optional().transform((v) => v === "true"),
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_RPC_URL_FALLBACK: z.string().url().optional(),
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet"]).default("mainnet-beta"),
  HIGHWAY_INDEXER_ENABLED: z.string().optional().default("true").transform((v) => v !== "false"),
  HIGHWAY_INDEXER_RPC: z.string().url().default("https://devnet.magicblock.app"),
  HIGHWAY_INDEXER_POLL_MS: z.coerce.number().int().positive().default(2000),
  USDC_MINT: z.string().min(32).optional(),
  TREASURY_USDC_ATA: z.string().min(32).optional(),
  FEE_PAYER_SECRET: z.string().min(1).optional(),
  FEE_PAYER_OWNER_PUBKEY: z.string().min(32).optional(),
  TREASURY_OWNER_PUBKEY: z.string().min(32).optional(),
  DEPOSIT_MIN_CENTS: z.coerce.number().int().positive().default(100),
  DEPOSIT_MAX_CENTS: z.coerce.number().int().positive().default(500),
  DEPOSIT_POLL_MS: z.coerce.number().int().positive().default(8000),
  // Coarse anti-abuse ceiling on client-reported earns (coins or scrap independently) per rolling
  // window. Deliberately generous — it must sit ABOVE the fastest legitimate play session and only
  // refuse implausible mint bursts; tune from real gameplay telemetry, never tighter than observed play.
  EARN_WINDOW_CEILING: z.coerce.number().int().positive().default(5000),
  EARN_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RUN_CONFIRMER: z.string().optional().default("true").transform((v) => v !== "false"),
  WITHDRAW_MIN_CENTS: z.coerce.number().int().positive().default(100),
  WITHDRAW_MAX_CENTS: z.coerce.number().int().positive().default(500),
  WITHDRAW_USER_DAILY_CAP_CENTS: z.coerce.number().int().positive().default(2000),
  WITHDRAW_GLOBAL_DAILY_CAP_CENTS: z.coerce.number().int().positive().default(20000),
  WITHDRAW_HOLD_HOURS: z.coerce.number().int().nonnegative().default(24),
  WITHDRAW_QUORUM_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(0),
  TREASURY_SECRET: z.string().min(1).optional(),
  WITHDRAW_POLL_MS: z.coerce.number().int().positive().default(4000),
  // Shared operator secret guarding the admin withdrawal-approval endpoint (the v1 stand-in for the
  // quorum/Intents co-signer). Unset => the admin surface is disabled AND withdrawals refuse to
  // reserve (no approval path => funds would strand). Min length keeps a weak secret from booting.
  ADMIN_API_SECRET: z.string().min(16).optional(),
  // Required for live Hermes prices after the 2026-08-26 Pyth Core upgrade. Unset → feed 401s
  // and the client HUD stays on SIM. Get a key at Pyth Terminal.
  PYTH_API_KEY: z.string().min(1).optional(),
});

const Env = EnvShape.superRefine((e, ctx) => {
  if (e.NODE_ENV === "production" && !e.SESSION_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SESSION_SECRET"],
      message: "SESSION_SECRET is required in production",
    });
  }
  if (!e.REAL_MONEY_ENABLED) return;
  for (const k of ["SOLANA_RPC_URL", "USDC_MINT", "TREASURY_USDC_ATA"] as const) {
    if (!e[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required when REAL_MONEY_ENABLED=true` });
  }
  if (!!e.FEE_PAYER_SECRET !== !!e.FEE_PAYER_OWNER_PUBKEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["FEE_PAYER_SECRET"],
      message: "FEE_PAYER_SECRET and FEE_PAYER_OWNER_PUBKEY must be set together",
    });
  }
  if (e.FEE_PAYER_SECRET && e.FEE_PAYER_OWNER_PUBKEY && !e.TREASURY_OWNER_PUBKEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TREASURY_OWNER_PUBKEY"],
      message: "TREASURY_OWNER_PUBKEY is required when fee sponsorship is configured",
    });
  }
  // The self-custody withdraw signer asserts its derived address == TREASURY_OWNER_PUBKEY at
  // boot; without the pubkey that assertion has nothing to check against (and would throw a
  // misleading "mismatch"). Require them together so a missing pubkey fails with a truthful message.
  if (e.TREASURY_SECRET && !e.TREASURY_OWNER_PUBKEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TREASURY_OWNER_PUBKEY"],
      message: "TREASURY_OWNER_PUBKEY is required when TREASURY_SECRET is set",
    });
  }
});

export type Env = z.infer<typeof Env>;
export function parseEnv(src: Record<string, string | undefined>): Env {
  return Env.parse(src);
}
export const env: Env = parseEnv(process.env);
