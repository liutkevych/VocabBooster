import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { createScheduler } from "../src/srs/scheduler.js";
import { createTestDb } from "./helpers.js";

let db: Db;
let app: FastifyInstance;
beforeEach(async () => {
  db = await createTestDb();
  app = buildApp(db, { scheduler: await createScheduler(), auth: null });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("API skeleton", () => {
  it("GET /health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /settings returns defaults", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.json()).toEqual({ new_cards_per_day: 20, sheet_id: null, last_sync_at: null, timezone: "UTC" });
  });

  it("PUT /settings updates fields partially", async () => {
    let res = await app.inject({ method: "PUT", url: "/api/settings", payload: { new_cards_per_day: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ new_cards_per_day: 10, sheet_id: null });

    res = await app.inject({ method: "PUT", url: "/api/settings", payload: { sheet_id: " abc123 " } });
    expect(res.json()).toMatchObject({ new_cards_per_day: 10, sheet_id: "abc123" });

    res = await app.inject({ method: "PUT", url: "/api/settings", payload: { timezone: "Europe/Kyiv" } });
    expect(res.json()).toMatchObject({ timezone: "Europe/Kyiv" });
  });

  it("PUT /settings rejects invalid input", async () => {
    for (const payload of [{ new_cards_per_day: -1 }, { new_cards_per_day: 1.5 }, { last_sync_at: "x" }, { timezone: "Mars/Olympus" }]) {
      const res = await app.inject({ method: "PUT", url: "/api/settings", payload });
      expect(res.statusCode).toBe(400);
    }
  });
});
