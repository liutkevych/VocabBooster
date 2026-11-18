import { mkdirSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db, Queryable } from "./db.js";

function wrap(pg: PGlite | Transaction): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pg.query<T>(sql, params);
      return { rows: res.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };
}

/**
 * Embedded Postgres (PGlite) for local development and tests: no database server needed.
 * dataDir = a folder to persist to, or undefined for in-memory.
 */
export function createPgliteDb(dataDir?: string): Db {
  // PGlite creates only the last folder, so create any missing parents (e.g. .data/) first.
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  return {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}
