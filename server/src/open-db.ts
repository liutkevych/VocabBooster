import type { Config } from "./config.js";
import { createPgDb, type Db } from "./db.js";

/**
 * DATABASE_URL=pglite:./.data/dev runs an embedded Postgres for local development.
 * PGlite is imported lazily so production (real Postgres) doesn't load it.
 */
export async function openDb(config: Pick<Config, "databaseUrl" | "databaseSsl" | "databaseSslCa">): Promise<Db> {
  const url = config.databaseUrl;
  if (url.startsWith("pglite:")) {
    const { createPgliteDb } = await import("./db-pglite.js");
    return createPgliteDb(url.slice("pglite:".length) || undefined);
  }
  return createPgDb(url, { ssl: config.databaseSsl, sslCa: config.databaseSslCa });
}
