import type { Db } from "../src/db.js";
import { createPgliteDb } from "../src/db-pglite.js";
import { migrate } from "../src/migrate.js";

/** In-memory Postgres (PGlite) with migrations applied. */
export async function createTestDb(): Promise<Db> {
  const db = createPgliteDb();
  await migrate(db);
  return db;
}
