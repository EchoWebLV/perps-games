import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../db/client.js";

describe("createDb (pglite)", () => {
  it("connects and runs a trivial query", async () => {
    const { db, driver, close } = createDb();
    expect(driver).toBe("pglite");
    const rows = await db.execute(sql`select 1 as one`);
    // pglite returns { rows: [...] }
    const one = (rows.rows ?? rows)[0].one;
    expect(Number(one)).toBe(1);
    await close();
  });
});
