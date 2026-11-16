import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { newCardEligibleSql } from "../srs/new-cards.js";

const StatsQuery = z.object({ deck: z.enum(["main", "other"]).default("main") });

/** How a local calendar day is computed from a timestamp, in the user's timezone. */
const LOCAL_DAY = "(reviewed_at AT TIME ZONE $1)::date";

/**
 * Consecutive days with at least one review, counting back from today.
 * If nothing has been reviewed yet today, the streak still counts up to yesterday (it isn't broken until the day ends).
 */
export function computeStreak(studyDays: string[], today: string): number {
  const days = new Set(studyDays);
  const cursor = new Date(`${today}T00:00:00Z`);
  if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export const statsRoutes =
  (db: Db, clock: () => Date): FastifyPluginAsync =>
  async (app) => {
    app.get("/stats", async (req) => {
      const { deck } = StatsQuery.parse(req.query);
      const now = clock().toISOString();

      const { rows: settings } = await db.query<{ timezone: string; new_cards_per_day: number }>(
        "SELECT timezone, new_cards_per_day FROM settings WHERE id = 1",
      );
      const { timezone, new_cards_per_day } = settings[0];

      // Local "today" and the instant the local day ends.
      const { rows: day } = await db.query<{ today: string; day_start: Date; day_end: Date }>(
        `SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS today,
                (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS day_start,
                ((date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2) AS day_end`,
        [now, timezone],
      );
      const { today, day_start, day_end } = day[0];

      const { rows: cards } = await db.query<{ due_now: number; due_today: number }>(
        `SELECT count(*) FILTER (WHERE c.due <= $2)::int AS due_now,
                count(*) FILTER (WHERE c.due < $3)::int AS due_today
         FROM cards c JOIN words w ON w.id = c.word_id
         WHERE NOT w.archived AND w.deck = $1 AND c.state <> 0`,
        [deck, now, new Date(day_end).toISOString()],
      );

      // A word is learned once both its cards (recognition and production) have graduated to review
      // at least once (state Review or Relearning). Seen = at least one card reviewed.
      const { rows: words } = await db.query<{ total: number; learned: number; seen: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE graduated = 2)::int AS learned,
                count(*) FILTER (WHERE seen > 0)::int AS seen
         FROM (
           SELECT w.id,
                  count(*) FILTER (WHERE c.state IN (2, 3)) AS graduated,
                  count(*) FILTER (WHERE c.state <> 0) AS seen
           FROM words w JOIN cards c ON c.word_id = w.id
           WHERE NOT w.archived AND w.deck = $1
           GROUP BY w.id
         ) per_word`,
        [deck],
      );

      const { rows: available } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cards c JOIN words w ON w.id = c.word_id
         WHERE ${newCardEligibleSql("$1", "$2")}`,
        [deck, new Date(day_start).toISOString()],
      );

      const { rows: introduced } = await db.query<{ n: number; reviews: number }>(
        `SELECT count(*) FILTER (WHERE state = 0)::int AS n, count(*)::int AS reviews
         FROM review_logs WHERE reviewed_at >= $1`,
        [new Date(day_start).toISOString()],
      );

      const { rows: days } = await db.query<{ day: string }>(
        `SELECT DISTINCT to_char(${LOCAL_DAY}, 'YYYY-MM-DD') AS day FROM review_logs
         WHERE reviewed_at <= $2 ORDER BY day DESC LIMIT 3660`,
        [timezone, now],
      );
      const studyDays = days.map((d) => d.day);

      return {
        today,
        timezone,
        due: {
          now: cards[0].due_now,
          today: cards[0].due_today,
          // New cards you can still start today: the daily limit, capped by what is actually available.
          new_remaining: Math.min(available[0].n, Math.max(0, new_cards_per_day - introduced[0].n)),
        },
        reviews_today: introduced[0].reviews,
        words: { total: words[0].total, learned: words[0].learned, in_progress: words[0].seen - words[0].learned },
        streak: { days: computeStreak(studyDays, today), studied_today: studyDays.includes(today) },
      };
    });
  };
