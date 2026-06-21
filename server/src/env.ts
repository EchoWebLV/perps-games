import { z } from "zod";
import "dotenv/config";

const Env = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  DEV_ENDPOINTS: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  NODE_ENV: z.string().optional().default("development"),
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
});

export type Env = z.infer<typeof Env>;
export function parseEnv(src: Record<string, string | undefined>): Env {
  return Env.parse(src);
}
export const env: Env = parseEnv(process.env);
