import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { setupAuth, type AuthConfig } from "./auth.js";
import type { Db } from "./db.js";
import type { SheetSource } from "./importer/sheets.js";
import { SyncError } from "./importer/sync.js";
import { importRoutes } from "./routes/import.js";
import { reviewRoutes } from "./routes/review.js";
import { settingsRoutes } from "./routes/settings.js";
import { statsRoutes } from "./routes/stats.js";
import type { Scheduler } from "./srs/scheduler.js";

export interface AppOptions {
  scheduler: Scheduler;
  /** Password protection. null = open (local development only). */
  auth: AuthConfig | null;
  logger?: boolean;
  sheetSource?: SheetSource | null;
  /** Folder with the built web app (web/dist) to serve at "/". Omit to serve the API only. */
  webRoot?: string;
  /**
   * Number of proxy hops to trust in X-Forwarded-For (for the client IP used by login rate limiting).
   * Fly.io: exactly 1. Never `true`: that trusts the left-most entry, which the client can forge.
   */
  trustProxyHops?: number;
  /** Injectable clock for tests. */
  clock?: () => Date;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function buildApp(db: Db, opts: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Trust only the nearest `n` proxies: the client IP is the entry they appended.
    ...(opts.trustProxyHops ? { trustProxy: (_addr: string, hop: number) => hop < opts.trustProxyHops! } : {}),
  });
  const clock = opts.clock ?? (() => new Date());

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    // SyncError messages are written for the user; hide other server errors.
    const expose = err instanceof SyncError || status < 500;
    return reply.code(status).send({ error: expose ? e.message : "Internal error" });
  });

  app.addHook("onSend", async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  });

  app.register(cookie);

  // Everything the web app calls lives under /api, behind the password.
  app.register(
    async (api) => {
      setupAuth(api, opts.auth, clock);
      api.get("/health", async (_req, reply) => {
        await db.query("SELECT 1");
        reply.header("cache-control", "no-store");
        return { ok: true };
      });
      api.register(settingsRoutes(db));
      api.register(importRoutes(db, opts.sheetSource ?? null));
      api.register(reviewRoutes(db, opts.scheduler, clock));
      api.register(statsRoutes(db, clock));
      api.addHook("onSend", async (_req, reply) => {
        reply.header("cache-control", "no-store");
      });
    },
    { prefix: "/api" },
  );

  if (opts.webRoot) {
    app.register(fastifyStatic, {
      root: opts.webRoot,
      setHeaders(reply, filePath) {
        // Vite fingerprints everything in assets/, so it can be cached forever.
        // index.html, the manifest and the service worker must always be revalidated.
        const fingerprinted = filePath.split(/[\\/]/).includes("assets");
        reply.header("cache-control", fingerprinted ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }

  return app;
}
