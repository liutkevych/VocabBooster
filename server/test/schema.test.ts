import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createTestDb } from "./helpers.js";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.close());

async function insertWord(key = "hello") {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO words (source_text, target_text, source_lang, target_lang, sheet_row_key)
     VALUES ('Hello', 'привіт', 'en', 'uk', $1) RETURNING id`,
    [key],
  );
  return rows[0].id;
}

describe("schema", () => {
  it("is idempotent to migrate twice", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("seeds a single settings row with defaults", async () => {
    const { rows } = await db.query("SELECT * FROM settings");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, new_cards_per_day: 20, sheet_id: null });
    await expect(db.query("INSERT INTO settings (id) VALUES (2)")).rejects.toThrow();
  });

  it("dedupes words on sheet_row_key", async () => {
    await insertWord("hello");
    await expect(insertWord("hello")).rejects.toThrow();
  });

  it("allows one card per word and direction, and cascades deletes", async () => {
    const wordId = await insertWord();
    await db.query(`INSERT INTO cards (word_id, direction) VALUES ($1, 'en_uk'), ($1, 'uk_en')`, [wordId]);
    await expect(
      db.query(`INSERT INTO cards (word_id, direction) VALUES ($1, 'en_uk')`, [wordId]),
    ).rejects.toThrow();
    await expect(
      db.query(`INSERT INTO cards (word_id, direction) VALUES ($1, 'xx')`, [wordId]),
    ).rejects.toThrow();

    const { rows: cards } = await db.query<{ id: string; state: number; reps: number }>(
      "SELECT id, state, reps FROM cards",
    );
    expect(cards[0]).toMatchObject({ state: 0, reps: 0 });

    await db.query(
      `INSERT INTO review_logs (card_id, rating, state, due, stability, difficulty, scheduled_days)
       VALUES ($1, 3, 0, now(), 0, 0, 0)`,
      [cards[0].id],
    );
    await expect(
      db.query(
        `INSERT INTO review_logs (card_id, rating, state, due, stability, difficulty, scheduled_days)
         VALUES ($1, 5, 0, now(), 0, 0, 0)`,
        [cards[0].id],
      ),
    ).rejects.toThrow();

    await db.query("DELETE FROM words WHERE id = $1", [wordId]);
    const { rows: left } = await db.query("SELECT 1 FROM cards UNION ALL SELECT 1 FROM review_logs");
    expect(left).toHaveLength(0);
  });
});
