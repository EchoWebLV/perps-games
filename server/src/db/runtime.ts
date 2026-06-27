import { createDb, type Db } from "./client.js";

export interface RuntimeDbConfig {
  databaseUrl?: string;
  nodeEnv: "development" | "test" | "production";
  realMoneyEnabled: boolean;
}

export function createRuntimeDb(cfg: RuntimeDbConfig): Db {
  if (cfg.databaseUrl) return createDb(cfg.databaseUrl);

  if (cfg.nodeEnv === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  if (cfg.realMoneyEnabled) {
    throw new Error("DATABASE_URL is required when REAL_MONEY_ENABLED=true");
  }

  console.warn("[db_ephemeral] DATABASE_URL unset; using in-memory PGlite for local soft-coin dev");
  return createDb();
}
