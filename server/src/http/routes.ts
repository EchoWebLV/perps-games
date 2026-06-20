import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Users } from "../services/users.js";
import type { Ledger } from "../services/ledger.js";
import type { Inventory } from "../services/inventory.js";
import { makeRequireUser } from "./auth.js";

export interface RouteDeps {
  users: Users;
  ledger: Ledger;
  inventory: Inventory;
  devEndpoints: boolean;
}

const GrantCoins = z.object({ amount: z.number().int().positive() });
const GrantCar = z.object({ carId: z.string().min(1) });

export function registerRoutes(server: FastifyInstance, deps: RouteDeps): void {
  const requireUser = makeRequireUser(deps.users);

  server.get("/v1/balance", { preHandler: requireUser }, async (req) => {
    return { balance: await deps.ledger.balance(req.userId!) };
  });

  server.get("/v1/inventory", { preHandler: requireUser }, async (req) => {
    const rows = await deps.inventory.list(req.userId!);
    return { cars: rows.map((r) => ({ carId: r.carId, acquiredAt: r.acquiredAt })) };
  });

  server.get("/v1/me", { preHandler: requireUser }, async (req) => {
    const userId = req.userId!;
    const [balance, rows] = await Promise.all([
      deps.ledger.balance(userId),
      deps.inventory.list(userId),
    ]);
    return {
      userId,
      balance,
      cars: rows.map((r) => ({ carId: r.carId, acquiredAt: r.acquiredAt })),
    };
  });

  if (deps.devEndpoints) {
    server.post("/v1/dev/grant-coins", { preHandler: requireUser }, async (req, reply) => {
      const parsed = GrantCoins.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      await deps.ledger.credit(req.userId!, parsed.data.amount, "dev_grant");
      return { balance: await deps.ledger.balance(req.userId!) };
    });

    server.post("/v1/dev/grant-car", { preHandler: requireUser }, async (req, reply) => {
      const parsed = GrantCar.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const granted = await deps.inventory.grant(req.userId!, parsed.data.carId);
      const rows = await deps.inventory.list(req.userId!);
      return { granted, cars: rows.map((r) => r.carId) };
    });
  }
}
