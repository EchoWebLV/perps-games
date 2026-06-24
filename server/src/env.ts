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
  CORS_ORIGINS: z.string().optional().default("http://localhost:3000"),
  START_BALANCE: z.coerce.number().int().nonnegative().default(10000), // cents → $100.00 faucet
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  PRIVY_VERIFICATION_KEY: z.string().optional(), // SPKI PEM → offline JWT verify
  DEV_AUTH: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),
  REAL_MONEY_ENABLED: z.string().optional().transform((v) => v === "true"),
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_RPC_URL_FALLBACK: z.string().url().optional(),
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet"]).default("mainnet-beta"),
  USDC_MINT: z.string().min(32).optional(),
  TREASURY_USDC_ATA: z.string().min(32).optional(),
  TREASURY_WALLET_ID: z.string().min(1).optional(),
  TREASURY_OWNER_PUBKEY: z.string().min(32).optional(),
  DEPOSIT_MIN_CENTS: z.coerce.number().int().positive().default(100),
  DEPOSIT_MAX_CENTS: z.coerce.number().int().positive().default(500),
  DEPOSIT_POLL_MS: z.coerce.number().int().positive().default(8000),
  RUN_CONFIRMER: z.string().optional().default("true").transform((v) => v !== "false"),
  WITHDRAW_MIN_CENTS: z.coerce.number().int().positive().default(100),
  WITHDRAW_MAX_CENTS: z.coerce.number().int().positive().default(500),
  WITHDRAW_USER_DAILY_CAP_CENTS: z.coerce.number().int().positive().default(2000),
  WITHDRAW_GLOBAL_DAILY_CAP_CENTS: z.coerce.number().int().positive().default(20000),
  WITHDRAW_HOLD_HOURS: z.coerce.number().int().nonnegative().default(24),
  WITHDRAW_QUORUM_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(0),
});

const Env = EnvShape.superRefine((e, ctx) => {
  if (!e.REAL_MONEY_ENABLED) return;
  for (const k of ["SOLANA_RPC_URL", "USDC_MINT", "TREASURY_USDC_ATA"] as const) {
    if (!e[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required when REAL_MONEY_ENABLED=true` });
  }
});

export type Env = z.infer<typeof Env>;
export function parseEnv(src: Record<string, string | undefined>): Env {
  return Env.parse(src);
}
export const env: Env = parseEnv(process.env);
