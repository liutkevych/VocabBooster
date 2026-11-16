import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { createScheduler, type Scheduler } from "../src/srs/scheduler.js";
import { createTestDb } from "./helpers.js";

let db: Db;
let app: FastifyInstance;
let scheduler: Scheduler;
let now: Date;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const advance = (ms: number) => (now = new Date(now.getTime() + ms));

interface QueueCard {
  id: string;
  word_id: string;
  direction: string;
  state: number;
  front: { text: string; lang: string };
  back: { text: string; lang: string };
  preview: Record<string, string>;
}
interface Queue {
  cards: QueueCard[];
  counts: { learning: number; review: number; new: number };
  new_limit: { per_day: number; introduced_today: number };
  next_due_at: string | null;
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
    payload: "English,Ukrainian,cat,кіт\nEnglish,Ukrainian,dog,собака\nEnglish,Ukrainian,tree,дерево\nEnglish,German,house,Haus\n",
  });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const queue = async (qs = ""): Promise<Queue> => (await app.inject({ method: "GET", url: `/api/queue${qs}` })).json();
const review = (card_id: string, rating: number, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/api/reviews", payload: { card_id, rating, ...extra } });

describe("GET /queue", () => {
  it("starts with the recognition card of each new word, with button previews", async () => {
    const q = await queue();
    expect(q.cards).toHaveLength(3);
    expect(q.cards.every((c) => c.direction === "en_uk" && c.state === 0)).toBe(true);
    expect(q.cards[0].front.lang).toBe("en");
    expect(q.cards[0].back.lang).toBe("uk");
    expect(Object.keys(q.cards[0].preview)).toEqual(["1", "2", "3", "4"]);
    expect(q.counts).toEqual({ learning: 0, review: 0, new: 3 });
    expect(q.next_due_at).toBeNull();
  });

  it("serves the Other deck separately", async () => {
    const q = await queue("?deck=other");
    expect(q.cards.map((c) => c.front.text)).toEqual(["house"]);
  });

  it("applies the daily new-card limit in the user's timezone", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { new_cards_per_day: 1, timezone: "Europe/Kyiv" } });
    now = new Date("2026-01-05T21:30:00Z"); // 23:30 in Kyiv

    const [first] = (await queue()).cards;
    await review(first.id, 3);
    let q = await queue();
    expect(q.counts.new).toBe(0);
    expect(q.new_limit).toEqual({ per_day: 1, introduced_today: 1 });

    advance(60 * MIN); // 00:30 in Kyiv: a new day
    q = await queue();
    expect(q.counts.new).toBe(1);
  });

  it("hides archived words", async () => {
    await db.query("UPDATE words SET archived = true WHERE sheet_row_key = 'cat'");
    const q = await queue();
    expect(q.cards.map((c) => c.front.text).sort()).toEqual(["dog", "tree"]);
  });
});

describe("review flow", () => {
  it("takes a new card through learning steps into review", async () => {
    const card = (await queue()).cards.find((c) => c.front.text === "cat")!;

    let res = await review(card.id, 3); // Good on a new card: next learning step in 10 min
    expect(res.statusCode).toBe(200);
    expect(res.json().card.state).toBe(1);
    expect(new Date(res.json().card.due).getTime() - now.getTime()).toBe(10 * MIN);

    let q = await queue();
    expect(q.cards.map((c) => c.id)).not.toContain(card.id);
    expect(q.next_due_at).toBe(new Date(now.getTime() + 10 * MIN).toISOString());

    advance(10 * MIN);
    q = await queue();
    expect(q.cards[0].id).toBe(card.id); // due learning cards come first
    expect(q.counts.learning).toBe(1);

    res = await review(card.id, 3); // Good again: graduates to review, due in days
    expect(res.json().card.state).toBe(2);
    expect(new Date(res.json().card.due).getTime() - now.getTime()).toBeGreaterThan(DAY);

    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM review_logs WHERE card_id = $1", [card.id]);
    expect(rows[0].n).toBe(2);
  });

  it("brings an Again card back after a minute, shown early when nothing else is left", async () => {
    const cards = (await queue()).cards;
    for (const c of cards.slice(1)) await review(c.id, 4); // Easy: straight to review
    const res = await review(cards[0].id, 1);
    expect(new Date(res.json().card.due).getTime() - now.getTime()).toBe(1 * MIN);

    // Not due yet, but it is the only card left, so learn-ahead serves it.
    const q = await queue();
    expect(q.cards.map((c) => c.id)).toEqual([cards[0].id]);
  });

  it("unlocks the production card (uk_en) the day after the word was first seen", async () => {
    const card = (await queue()).cards.find((c) => c.front.text === "cat")!;
    await review(card.id, 4);

    let q = await queue();
    expect(q.cards.some((c) => c.word_id === card.word_id && c.direction === "uk_en")).toBe(false);

    advance(DAY);
    q = await queue();
    const prod = q.cards.find((c) => c.word_id === card.word_id && c.direction === "uk_en");
    expect(prod).toMatchObject({ front: { text: "кіт", lang: "uk" }, back: { text: "cat", lang: "en" } });
  });

  it("is idempotent on client_review_id", async () => {
    const [card] = (await queue()).cards;
    const client_review_id = randomUUID();
    const a = await review(card.id, 3, { client_review_id, duration_ms: 2500 });
    const b = await review(card.id, 3, { client_review_id });
    expect(a.json().duplicate).toBe(false);
    expect(b.json()).toEqual({ ...a.json(), duplicate: true });

    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM review_logs");
    expect(rows[0].n).toBe(1);

    const [other] = (await queue()).cards.filter((c) => c.id !== card.id);
    expect((await review(other.id, 3, { client_review_id })).statusCode).toBe(409);
  });

  it("validates input", async () => {
    const [card] = (await queue()).cards;
    expect((await review(card.id, 5)).statusCode).toBe(400);
    expect((await review("not-a-uuid", 3)).statusCode).toBe(400);
    expect((await review(randomUUID(), 3)).statusCode).toBe(404);
  });
});
