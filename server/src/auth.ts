import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

/**
 * Single-user protection: one password (APP_PASSWORD) and a long-lived signed session cookie.
 * The cookie is stateless: `<expiry ms>.<HMAC>`. The HMAC key is derived from SESSION_SECRET *and*
 * the password, so changing either one signs every device out.
 */
export interface AuthConfig {
  password: string;
  sessionSecret: string;
  /** Secure flag on the cookie (HTTPS only). On in production. */
  secureCookie: boolean;
  sessionDays?: number;
}

export const SESSION_COOKIE = "vocab_session";

/** API paths reachable without a session. */
const PUBLIC_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me"]);

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_DELAY_MS = 400;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function signingKey(cfg: AuthConfig): Buffer {
  return createHmac("sha256", cfg.sessionSecret).update(cfg.password).digest();
}

function sign(cfg: AuthConfig, expiresAt: number): string {
  return createHmac("sha256", signingKey(cfg)).update(`v1.${expiresAt}`).digest("base64url");
}

export function createSessionToken(cfg: AuthConfig, now: number): { token: string; maxAgeSec: number } {
  const maxAgeSec = (cfg.sessionDays ?? 365) * 24 * 60 * 60;
  const expiresAt = now + maxAgeSec * 1000;
  return { token: `${expiresAt}.${sign(cfg, expiresAt)}`, maxAgeSec };
}

export function verifySessionToken(cfg: AuthConfig, token: string | undefined, now: number): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(cfg, expiresAt));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function passwordMatches(cfg: AuthConfig, attempt: string): boolean {
  // Hash both so the comparison is constant-time regardless of length.
  return timingSafeEqual(sha256(attempt), sha256(cfg.password));
}

/** Failed login attempts per client IP, in memory (one server, one user). */
class LoginLimiter {
  private failures = new Map<string, { count: number; first: number }>();

  retryAfterSec(ip: string, now: number): number {
    const f = this.failures.get(ip);
    if (!f || now - f.first > FAILURE_WINDOW_MS) return 0;
    return f.count >= MAX_FAILURES ? Math.ceil((f.first + FAILURE_WINDOW_MS - now) / 1000) : 0;
  }

  fail(ip: string, now: number) {
    const f = this.failures.get(ip);
    if (!f || now - f.first > FAILURE_WINDOW_MS) this.failures.set(ip, { count: 1, first: now });
    else f.count++;
    if (this.failures.size > 10_000) this.failures.clear(); // bound memory
  }

  succeed(ip: string) {
    this.failures.delete(ip);
  }
}

const LoginBody = z.object({ password: z.string().min(1).max(1000) });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Adds /auth/* routes and, when auth is configured, a guard on every route in `app`'s scope.
 * Call it directly on the /api scope (not via register(): Fastify would encapsulate the guard
 * hook to a child scope and leave the other routes unprotected). With auth = null everything is open.
 */
export function setupAuth(app: FastifyInstance, auth: AuthConfig | null, clock: () => Date): void {
  const limiter = new LoginLimiter();
  const isAuthenticated = (req: FastifyRequest) =>
    auth === null || verifySessionToken(auth, req.cookies[SESSION_COOKIE], clock().getTime());

  app.addHook("onRequest", async (req, reply) => {
    if (auth === null) return;
    const path = req.url.split("?")[0];
    if (PUBLIC_PATHS.has(path) || isAuthenticated(req)) return;
    return reply.code(401).send({ error: "Not signed in" });
  });

  app.get("/auth/me", async (req) => ({ authenticated: isAuthenticated(req), required: auth !== null }));

  app.post("/auth/login", async (req, reply) => {
    if (auth === null) return { authenticated: true };
    const now = clock().getTime();
    const retryAfter = limiter.retryAfterSec(req.ip, now);
    if (retryAfter > 0) {
      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} min.` });
    }

    const { password } = LoginBody.parse(req.body);
    if (!passwordMatches(auth, password)) {
      limiter.fail(req.ip, now);
      await wait(FAILURE_DELAY_MS);
      return reply.code(401).send({ error: "Wrong password" });
    }

    limiter.succeed(req.ip);
    const { token, maxAgeSec } = createSessionToken(auth, now);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: auth.secureCookie,
      sameSite: "strict",
      maxAge: maxAgeSec,
    });
    return { authenticated: true };
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, secure: auth?.secureCookie ?? false, sameSite: "strict" });
    return { authenticated: false };
  });
}
