import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { computeStreak } from "../src/routes/stats.js";
import { createScheduler, type Scheduler } from "../src/srs/scheduler.js";
import { createTestDb } from "./helpers.js";

describe("computeStreak", () => {
  it("counts consecutive days ending today", () => {
    expect(computeStreak(["2026-01-05", "2026-01-04", "2026-01-03", "2026-01-01"], "2026-01-05")).toBe(3);
  });
  it("keeps yesterday's streak alive until today ends", () => {
    expect(computeStreak(["2026-01-04", "2026-01-03"], "2026-01-05")).toBe(2);
  });
  it("is zero after a missed day", () => {
    expect(computeStreak(["2026-01-03"], "2026-01-05")).toBe(0);
    expect(computeStreak([], "2026-01-05")).toBe(0);
  });
  it("crosses month and year boundaries", () => {
    expect(computeStreak(["2026-01-01", "2025-12-31", "2025-12-30"], "2026-01-01")).toBe(3);
  });
});

let db: Db;
let app: FastifyInstance;
let scheduler: Scheduler;
let now: Date;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Stats {
  today: string;
  due: { now: number; today: number; new_remaining: number };
  reviews_today: number;
  words: { total: number; learned: number; in_progress: number };
  streak: { days: number; studied_today: boolean };
}

beforeAll(async () => {
  scheduler = await createScheduler({ enableFuzz: false });
});
beforeEach(async () => {
  db = await createTestDb();
  now = new Date("2026-01-05T08:00:00Z");
  app = buildApp(db, { scheduler, clock: () => now, auth: null });
  await app.inject({
    method: "POST",
    url: "/api/import/csv",
    headers: { "content-type": "text/csv" },
    payload: "English,Ukrainian,cat,кіт\nEnglish,Ukrainian,dog,собака\nEnglish,Ukrainian,tree,дерево\n",
  });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const stats = async (): Promise<Stats> => (await app.inject({ method: "GET", url: "/api/stats" })).json();
const cardOf = async (word: string, direction = "en_uk") =>
  (
    await db.query<{ id: string }>(
      "SELECT c.id FROM cards c JOIN words w ON w.id = c.word_id WHERE w.sheet_row_key = $1 AND c.direction = $2",
      [word, direction],
    )
  ).rows[0].id;
const review = (card_id: string, rating: number) =>
  app.inject({ method: "POST", url: "/api/reviews", payload: { card_id, rating } });

describe("GET /stats", () => {
  it("starts empty", async () => {
    expect(await stats()).toMatchObject({
      today: "2026-01-05",
      due: { now: 0, today: 0, new_remaining: 3 }, // 3 words: only their en_uk cards are available
      reviews_today: 0,
      words: { total: 3, learned: 0, in_progress: 0 },
      streak: { days: 0, studied_today: false },
    });
  });

  it("counts learned words only when both directions have graduated", async () => {
    await review(await cardOf("cat"), 4); // Easy: straight to review
    let s = await stats();
    expect(s.words).toEqual({ total: 3, learned: 0, in_progress: 1 });
    expect(s.due.new_remaining).toBe(2); // cat's uk_en unlocks tomorrow
    expect(s.reviews_today).toBe(1);

    await review(await cardOf("cat", "uk_en"), 4);
    s = await stats();
    expect(s.words).toEqual({ total: 3, learned: 1, in_progress: 0 });
  });

  it("counts cards due by the end of today, including learning steps", async () => {
    await review(await cardOf("cat"), 3); // learning, due in 10 min
    let s = await stats();
    expect(s.due).toMatchObject({ now: 0, today: 1 });

    now = new Date(now.getTime() + 15 * 60_000);
    s = await stats();
    expect(s.due).toMatchObject({ now: 1, today: 1 });
  });

  it("tracks the study streak by local day", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { timezone: "Europe/Kyiv" } });
    const cat = await cardOf("cat");

    // Day 1 at 23:30 Kyiv time (21:30 UTC)
    now = new Date("2026-01-05T21:30:00Z");
    await review(cat, 1);
    expect((await stats()).streak).toEqual({ days: 1, studied_today: true });

    // An hour later it's the next local day: streak kept, but not studied yet today.
    now = new Date(now.getTime() + HOUR);
    expect((await stats()).streak).toEqual({ days: 1, studied_today: false });
    await review(cat, 1);
    expect((await stats()).streak).toEqual({ days: 2, studied_today: true });

    // Skip a whole day: streak broken.
    now = new Date(now.getTime() + 2 * DAY);
    expect((await stats()).streak).toEqual({ days: 0, studied_today: false });
  });

  it("caps new_remaining by the daily limit", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { new_cards_per_day: 1 } });
    expect((await stats()).due.new_remaining).toBe(1);
    await review(await cardOf("cat"), 4);
    expect((await stats()).due.new_remaining).toBe(0);
  });

  it("ignores archived words", async () => {
    await review(await cardOf("cat"), 4);
    await db.query("UPDATE words SET archived = true WHERE sheet_row_key = 'cat'");
    expect((await stats()).words).toEqual({ total: 2, learned: 0, in_progress: 0 });
  });
});
