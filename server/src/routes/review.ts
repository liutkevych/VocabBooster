import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db, Queryable } from "../db.js";
import { newCardEligibleSql } from "../srs/new-cards.js";
import { CARD_STATE_COLUMNS, previewDue, reviewCard, type CardRow, type Scheduler } from "../srs/scheduler.js";

/** Learning cards due within this window are shown early when nothing else is left (like Anki). */
const LEARN_AHEAD_MS = 20 * 60 * 1000;

const QueueQuery = z.object({
  deck: z.enum(["main", "other"]).default("main"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ReviewBody = z.object({
  card_id: z.uuid(),
  rating: z.number().int().min(1).max(4),
  client_review_id: z.uuid().optional(),
  duration_ms: z.number().int().min(0).max(3_600_000).optional(),
});

interface QueueRow extends CardRow {
  word_id: string;
  direction: "en_uk" | "uk_en";
  deck: string;
  source_text: string;
  target_text: string;
  source_lang: string;
  target_lang: string;
}

const SELECT_CARD = `
  SELECT c.id, c.word_id, c.direction, ${CARD_STATE_COLUMNS.split(", ").map((col) => `c.${col}`).join(", ")},
         w.deck, w.source_text, w.target_text, w.source_lang, w.target_lang
  FROM cards c JOIN words w ON w.id = c.word_id`;

/** Start of "today" in the user's timezone. */
async function dayStart(q: Queryable, now: Date, timezone: string): Promise<Date> {
  const { rows } = await q.query<{ day_start: Date }>(
    "SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS day_start",
    [now.toISOString(), timezone],
  );
  return new Date(rows[0].day_start);
}

/** Spread new cards evenly among reviews so a long session isn't all reviews then all new. */
function interleave<T>(reviews: T[], fresh: T[]): T[] {
  if (!fresh.length) return reviews;
  if (!reviews.length) return fresh;
  const out: T[] = [];
  const every = (reviews.length + fresh.length) / fresh.length;
  let r = 0;
  let n = 0;
  for (let i = 0; i < reviews.length + fresh.length; i++) {
    const wantNew = n < fresh.length && (r >= reviews.length || i + 1 >= Math.round((n + 1) * every));
    out.push(wantNew ? fresh[n++] : reviews[r++]);
  }
  return out;
}

export const reviewRoutes =
  (db: Db, scheduler: Scheduler, clock: () => Date): FastifyPluginAsync =>
  async (app) => {
    app.get("/queue", async (req) => {
      const { deck, limit } = QueueQuery.parse(req.query);
      const now = clock();
      const nowIso = now.toISOString();

      const { rows: settingsRows } = await db.query<{ new_cards_per_day: number; timezone: string }>(
        "SELECT new_cards_per_day, timezone FROM settings WHERE id = 1",
      );
      const { new_cards_per_day, timezone } = settingsRows[0];
      const today = await dayStart(db, now, timezone);

      // New cards introduced today = first reviews (log state 0 = New) since local midnight.
      const { rows: introduced } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM review_logs WHERE state = 0 AND reviewed_at >= $1",
        [today.toISOString()],
      );
      const newRemaining = Math.max(0, new_cards_per_day - introduced[0].n);

      // Due learning/relearning first (time-sensitive), then reviews by due date.
      const { rows: due } = await db.query<QueueRow>(
        `${SELECT_CARD}
         WHERE NOT w.archived AND w.deck = $1 AND c.state <> 0 AND c.due <= $2
         ORDER BY (c.state IN (1, 3)) DESC, c.due
         LIMIT $3`,
        [deck, nowIso, limit],
      );

      const { rows: fresh } = await db.query<QueueRow>(
        `${SELECT_CARD} WHERE ${newCardEligibleSql("$1", "$2")} ORDER BY w.created_at, w.id, c.direction LIMIT $3`,
        [deck, today.toISOString(), Math.min(newRemaining, limit)],
      );

      let cards = interleave(due, fresh).slice(0, limit);

      if (cards.length === 0) {
        const { rows: ahead } = await db.query<QueueRow>(
          `${SELECT_CARD}
           WHERE NOT w.archived AND w.deck = $1 AND c.state IN (1, 3) AND c.due <= $2
           ORDER BY c.due LIMIT $3`,
          [deck, new Date(now.getTime() + LEARN_AHEAD_MS).toISOString(), limit],
        );
        cards = ahead;
      }

      const { rows: counts } = await db.query<{ learning: number; review: number; new_available: number }>(
        `SELECT
           count(*) FILTER (WHERE c.state IN (1, 3) AND c.due <= $2)::int AS learning,
           count(*) FILTER (WHERE c.state = 2 AND c.due <= $2)::int AS review,
           (SELECT count(*)::int FROM cards c JOIN words w ON w.id = c.word_id WHERE ${newCardEligibleSql("$1", "$3")}) AS new_available
         FROM cards c JOIN words w ON w.id = c.word_id
         WHERE NOT w.archived AND w.deck = $1`,
        [deck, nowIso, today.toISOString()],
      );

      // Earliest future learning card, so the client knows when to check back.
      const { rows: next } = await db.query<{ due: Date }>(
        `SELECT c.due FROM cards c JOIN words w ON w.id = c.word_id
         WHERE NOT w.archived AND w.deck = $1 AND c.state <> 0 AND c.due > $2
         ORDER BY c.due LIMIT 1`,
        [deck, nowIso],
      );

      return {
        cards: cards.map((c) => {
          const en = { text: c.source_text, lang: c.source_lang };
          const uk = { text: c.target_text, lang: c.target_lang };
          return {
            id: c.id,
            word_id: c.word_id,
            direction: c.direction,
            state: c.state,
            front: c.direction === "en_uk" ? en : uk,
            back: c.direction === "en_uk" ? uk : en,
            preview: previewDue(scheduler, c, now),
          };
        }),
        counts: {
          learning: counts[0].learning,
          review: counts[0].review,
          new: Math.min(newRemaining, counts[0].new_available),
        },
        new_limit: { per_day: new_cards_per_day, introduced_today: introduced[0].n },
        next_due_at: next[0] ? new Date(next[0].due).toISOString() : null,
      };
    });

    app.post("/reviews", async (req, reply) => {
      const body = ReviewBody.parse(req.body);
      const now = clock();

      const result = await db.transaction(async (tx) => {
        if (body.client_review_id) {
          const { rows } = await tx.query<{ card_id: string }>(
            "SELECT card_id FROM review_logs WHERE client_review_id = $1",
            [body.client_review_id],
          );
          if (rows[0]) {
            if (rows[0].card_id !== body.card_id) return { conflict: true as const };
            const { rows: card } = await tx.query<CardRow>(
              `SELECT id, ${CARD_STATE_COLUMNS} FROM cards WHERE id = $1`,
              [body.card_id],
            );
            return { card: card[0], duplicate: true };
          }
        }

        const { rows } = await tx.query<CardRow>(
          `SELECT id, ${CARD_STATE_COLUMNS} FROM cards WHERE id = $1 FOR UPDATE`,
          [body.card_id],
        );
        if (!rows[0]) return null;

        const { card, log } = reviewCard(scheduler, rows[0], body.rating as 1 | 2 | 3 | 4, now);
        const { rows: updated } = await tx.query<CardRow>(
          `UPDATE cards SET due = $2, stability = $3, stability_fast = $4, difficulty = $5, scheduled_days = $6,
             learning_steps = $7, reps = $8, lapses = $9, state = $10, schedule_status = $11, last_review = $12
           WHERE id = $1 RETURNING id, ${CARD_STATE_COLUMNS}`,
          [
            body.card_id,
            card.due.toISOString(),
            card.stability,
            card.stability_fast,
            card.difficulty,
            card.scheduled_days,
            card.learning_steps,
            card.reps,
            card.lapses,
            card.state,
            card.schedule_status,
            card.last_review?.toISOString() ?? null,
          ],
        );
        await tx.query(
          `INSERT INTO review_logs (card_id, rating, reviewed_at, state, schedule_status, due, stability, stability_fast,
             difficulty, scheduled_days, learning_steps, last_review, client_review_id, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            body.card_id,
            log.rating,
            log.reviewed_at.toISOString(),
            log.state,
            log.schedule_status,
            log.due.toISOString(),
            log.stability,
            log.stability_fast,
            log.difficulty,
            log.scheduled_days,
            log.learning_steps,
            log.last_review?.toISOString() ?? null,
            body.client_review_id ?? null,
            body.duration_ms ?? null,
          ],
        );
        return { card: updated[0], duplicate: false };
      });

      if (!result) return reply.code(404).send({ error: "Card not found" });
      if ("conflict" in result) {
        return reply.code(409).send({ error: "client_review_id was already used for a different card" });
      }
      const c = result.card;
      return {
        card: {
          id: c.id,
          state: c.state,
          due: new Date(c.due).toISOString(),
          reps: c.reps,
          lapses: c.lapses,
          stability: c.stability,
          difficulty: c.difficulty,
        },
        duplicate: result.duplicate,
      };
    });
  };
