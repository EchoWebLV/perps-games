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
});

export type Env = z.infer<typeof Env>;
export const env: Env = Env.parse(process.env);
