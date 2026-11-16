import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";

export interface Settings {
  new_cards_per_day: number;
  sheet_id: string | null;
  last_sync_at: string | null;
  timezone: string;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const UpdateSettings = z
  .object({
    new_cards_per_day: z.number().int().min(0).max(1000),
    sheet_id: z.string().trim().min(1).nullable(),
    timezone: z.string().refine(isValidTimezone, "Unknown IANA timezone, e.g. Europe/Kyiv"),
  })
  .partial()
  .strict();

const SELECT = "SELECT new_cards_per_day, sheet_id, last_sync_at, timezone FROM settings WHERE id = 1";

export const settingsRoutes =
  (db: Db): FastifyPluginAsync =>
  async (app) => {
    app.get("/settings", async () => {
      const { rows } = await db.query<Settings>(SELECT);
      return rows[0];
    });

    app.put("/settings", async (req) => {
      const body = UpdateSettings.parse(req.body ?? {});
      const entries = Object.entries(body);
      if (entries.length > 0) {
        // Keys come from the strict zod schema, so they are safe column names.
        const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(", ");
        await db.query(
          `UPDATE settings SET ${sets} WHERE id = 1`,
          entries.map(([, v]) => v),
        );
      }
      const { rows } = await db.query<Settings>(SELECT);
      return rows[0];
    });
  };
