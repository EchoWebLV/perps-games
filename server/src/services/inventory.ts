import { eq, and } from "drizzle-orm";
import { inventory, type InventoryRow } from "../db/schema.js";

export function makeInventory(db: any) {
  return {
    /** grant a car. idempotent: granting an owned car is a no-op, returns false. */
    async grant(userId: string, carId: string): Promise<boolean> {
      const inserted = await db
        .insert(inventory)
        .values({ userId, carId })
        .onConflictDoNothing({ target: [inventory.userId, inventory.carId] })
        .returning();
      return inserted.length > 0;
    },
    async list(userId: string): Promise<InventoryRow[]> {
      return db.select().from(inventory).where(eq(inventory.userId, userId));
    },
    async owns(userId: string, carId: string): Promise<boolean> {
      const rows = await db
        .select()
        .from(inventory)
        .where(and(eq(inventory.userId, userId), eq(inventory.carId, carId)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

export type Inventory = ReturnType<typeof makeInventory>;
