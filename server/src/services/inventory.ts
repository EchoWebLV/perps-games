import { eq, and, gt, sql } from "drizzle-orm";
import { inventory, type InventoryRow } from "../db/schema.js";

export function makeInventory(db: any) {
  async function count(userId: string, carId: string): Promise<number> {
    const rows = await db
      .select({ count: inventory.count })
      .from(inventory)
      .where(and(eq(inventory.userId, userId), eq(inventory.carId, carId)))
      .limit(1);
    return rows[0]?.count ?? 0;
  }

  return {
    /** grant `n` copies (default 1) in a single write; dupes stack. isNew = the 0->N first unlock. */
    async grant(userId: string, carId: string, n = 1): Promise<{ isNew: boolean; count: number }> {
      const rows = await db
        .insert(inventory)
        .values({ userId, carId, count: n })
        .onConflictDoUpdate({
          target: [inventory.userId, inventory.carId],
          set: { count: sql`${inventory.count} + ${n}` },
        })
        .returning({ count: inventory.count });
      const c = rows[0].count as number;
      return { isNew: c === n, count: c };
    },

    /** shed one spare; the last copy is never lost. */
    async melt(userId: string, carId: string): Promise<{ melted: boolean; count: number }> {
      const rows = await db
        .update(inventory)
        .set({ count: sql`${inventory.count} - 1` })
        .where(and(eq(inventory.userId, userId), eq(inventory.carId, carId), gt(inventory.count, 1)))
        .returning({ count: inventory.count });
      if (rows[0]) return { melted: true, count: rows[0].count as number };
      return { melted: false, count: await count(userId, carId) };
    },

    count,

    async list(userId: string): Promise<InventoryRow[]> {
      return db.select().from(inventory).where(eq(inventory.userId, userId));
    },

    async owns(userId: string, carId: string): Promise<boolean> {
      return (await count(userId, carId)) > 0;
    },
  };
}

export type Inventory = ReturnType<typeof makeInventory>;
