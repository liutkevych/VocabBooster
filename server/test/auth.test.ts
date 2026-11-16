import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { createSessionToken, verifySessionToken, type AuthConfig } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { createScheduler, type Scheduler } from "../src/srs/scheduler.js";
import { createTestDb } from "./helpers.js";

const auth: AuthConfig = {
  password: "correct horse battery",
  sessionSecret: "s".repeat(40),
  secureCookie: true,
};

let db: Db;
let app: FastifyInstance;
let scheduler: Scheduler;
let now: Date;
let webRoot: string;

beforeAll(async () => {
  scheduler = await createScheduler({ enableFuzz: false });
  webRoot = mkdtempSync(path.join(tmpdir(), "vocab-web-"));
  mkdirSync(path.join(webRoot, "assets"));
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Vocab</title>");
  writeFileSync(path.join(webRoot, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(path.join(webRoot, "manifest.webmanifest"), "{}");
});
beforeEach(async () => {
  db = await createTestDb();
  now = new Date("2026-01-05T08:00:00Z");
  app = buildApp(db, { scheduler, auth, clock: () => now, webRoot });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const login = (password: string, ip = "10.0.0.1") =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { password }, remoteAddress: ip });
const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name === "vocab_session");
  return c ? `vocab_session=${c.value}` : "";
};

describe("session tokens", () => {
  it("verify until they expire", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const { token, maxAgeSec } = createSessionToken(auth, t0);
    expect(maxAgeSec).toBe(365 * 24 * 3600);
    expect(verifySessionToken(auth, token, t0 + 1000)).toBe(true);
    expect(verifySessionToken(auth, token, t0 + maxAgeSec * 1000 + 1)).toBe(false);
  });

  it("reject tampering, and are invalidated by a new password or secret", () => {
    const { token } = createSessionToken(auth, 0);
    const [exp, sig] = token.split(".");
    expect(verifySessionToken(auth, `${Number(exp) + 1000}.${sig}`, 1)).toBe(false);
    expect(verifySessionToken(auth, `${exp}.${sig.slice(0, -1)}x`, 1)).toBe(false);
    expect(verifySessionToken(auth, "garbage", 1)).toBe(false);
    expect(verifySessionToken({ ...auth, password: "another password" }, token, 1)).toBe(false);
    expect(verifySessionToken({ ...auth, sessionSecret: "t".repeat(40) }, token, 1)).toBe(false);
  });
});

describe("password protection", () => {
  it("blocks the API without a session but leaves health and auth endpoints open", async () => {
    expect((await app.inject({ method: "GET", url: "/api/queue" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/sync" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.json()).toEqual({ authenticated: false, required: true });
  });

  it("logs in with the right password and sets a long-lived, locked-down cookie", async () => {
    const res = await login("correct horse battery");
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === "vocab_session")!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 365 * 24 * 3600 });

    const cookie = cookieOf(res);
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json()).toEqual({
      authenticated: true,
      required: true,
    });
  });

  it("rejects a wrong password and sets no cookie", async () => {
    const res = await login("wrong");
    expect(res.statusCode).toBe(401);
    expect(cookieOf(res)).toBe("");
  });

  it("rate-limits repeated failures per client", async () => {
    for (let i = 0; i < 5; i++) expect((await login("wrong")).statusCode).toBe(401);
    const blocked = await login("correct horse battery");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // Another client isn't affected, and the block lifts after the window.
    expect((await login("correct horse battery", "10.0.0.2")).statusCode).toBe(200);
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await login("correct horse battery")).statusCode).toBe(200);
  });

  it("can't dodge the rate limit by forging X-Forwarded-For behind one proxy hop", async () => {
    const proxied = buildApp(db, { scheduler, auth, clock: () => now, trustProxyHops: 1 });
    // The platform proxy appends the real client IP (last entry); the client controls the rest.
    const attempt = (forged: string) =>
      proxied.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "wrong" },
        remoteAddress: "172.16.0.1",
        headers: { "x-forwarded-for": `${forged}, 203.0.113.9` },
      });
    for (let i = 0; i < 5; i++) await attempt(`198.51.100.${i}`);
    expect((await attempt("198.51.100.99")).statusCode).toBe(429);
    await proxied.close();
  });

  it("logs out by clearing the cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    const c = res.cookies.find((x) => x.name === "vocab_session")!;
    expect(c.value).toBe("");
  });

  it("stays open with auth disabled (local development)", async () => {
    const open = buildApp(db, { scheduler, auth: null });
    expect((await open.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(200);
    expect((await open.inject({ method: "GET", url: "/api/auth/me" })).json()).toEqual({ authenticated: true, required: false });
    await open.close();
  });
});

describe("serving the web app", () => {
  it("serves index.html without login, with revalidation and security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Vocab</title>");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("caches fingerprinted assets forever", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("never caches API responses", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://x" };

  it("requires a password and session secret in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/APP_PASSWORD/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", APP_PASSWORD: "longenough" })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", APP_PASSWORD: "short", SESSION_SECRET: "s".repeat(40) })).toThrow(
      /at least 8/,
    );
    const cfg = loadConfig({ ...base, NODE_ENV: "production", APP_PASSWORD: "longenough", SESSION_SECRET: "s".repeat(40) });
    expect(cfg.auth).toMatchObject({ secureCookie: true });
    expect(cfg.databaseSsl).toBe("verify");
  });

  it("refuses the embedded dev database in production", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "pglite:./x", NODE_ENV: "production", APP_PASSWORD: "longenough", SESSION_SECRET: "s".repeat(40) }),
    ).toThrow(/local development/);
  });

  it("allows an open API in development", () => {
    expect(loadConfig(base).auth).toBeNull();
    expect(loadConfig(base).databaseSsl).toBe("off");
  });
});
