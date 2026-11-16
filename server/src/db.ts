import pg from "pg";

/** Minimal query interface shared by node-postgres and PGlite (used in tests). */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run several statements (no params), e.g. a migration file. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs fn in a transaction; commits on success, rolls back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgOptions {
  ssl: "verify" | "no-verify" | "off";
  /** Extra CA certificate (PEM) to trust. */
  sslCa?: string;
  /** Pool size. Keep small: Supabase's free plan has a low connection limit. */
  max?: number;
}

function wrapPg(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

/** Removes sslmode & co. from the URL so the explicit `ssl` option below is what applies. */
function stripSslParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    for (const p of ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(p);
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function createPgDb(connectionString: string, opts: PgOptions = { ssl: "off" }): Db {
  const ssl =
    opts.ssl === "off"
      ? false
      : opts.ssl === "no-verify"
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true, ...(opts.sslCa ? { ca: opts.sslCa } : {}) };

  const pool = new pg.Pool({
    connectionString: stripSslParams(connectionString),
    ssl,
    max: opts.max ?? 5,
    idleTimeoutMillis: 30_000,
  });
  // An idle client losing its connection (e.g. database restart) must not crash the process.
  pool.on("error", (err) => console.error("postgres pool error:", err.message));

  return {
    ...wrapPg(pool),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrapPg(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
