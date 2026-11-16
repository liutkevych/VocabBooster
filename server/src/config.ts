import type { AuthConfig } from "./auth.js";

export interface Config {
  databaseUrl: string;
  /** How to verify the database's TLS certificate. See README "Database SSL". */
  databaseSsl: "verify" | "no-verify" | "off";
  /** Extra CA certificate (PEM) to trust, e.g. Supabase's. */
  databaseSslCa?: string;
  port: number;
  production: boolean;
  /** Cron expression for the daily Sheet sync. */
  syncCron: string;
  syncTimezone: string;
  auth: AuthConfig | null;
  /** Built web app to serve, if any. */
  webRoot?: string;
}

export function loadConfig(env = process.env): Config {
  const production = env.NODE_ENV === "production";

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (see server/.env.example)");
  if (production && databaseUrl.startsWith("pglite:")) {
    // PGlite needs over 1 GB of memory and is meant for local development only.
    throw new Error("DATABASE_URL=pglite: is for local development. Use a real Postgres (Supabase) in production.");
  }

  const databaseSsl = env.DATABASE_SSL ?? (production ? "verify" : "off");
  if (databaseSsl !== "verify" && databaseSsl !== "no-verify" && databaseSsl !== "off") {
    throw new Error(`DATABASE_SSL must be verify, no-verify or off (got "${databaseSsl}")`);
  }

  const password = env.APP_PASSWORD;
  const sessionSecret = env.SESSION_SECRET;
  let auth: AuthConfig | null = null;
  if (password || sessionSecret || production) {
    if (!password || password.length < 8) throw new Error("APP_PASSWORD must be set, at least 8 characters");
    if (!sessionSecret || sessionSecret.length < 32) {
      throw new Error("SESSION_SECRET must be set, at least 32 characters (e.g. openssl rand -base64 48)");
    }
    auth = { password, sessionSecret, secureCookie: production };
  }

  return {
    databaseUrl,
    databaseSsl,
    databaseSslCa: env.DATABASE_SSL_CA?.replace(/\\n/g, "\n") || undefined,
    port: Number(env.PORT ?? 3000),
    production,
    syncCron: env.SYNC_CRON ?? "0 4 * * *",
    syncTimezone: env.SYNC_TIMEZONE ?? "UTC",
    auth,
    webRoot: env.WEB_ROOT || undefined,
  };
}
