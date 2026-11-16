import type { Db } from "../db.js";
import { applyImport, type ImportSummary } from "./apply.js";
import { parseRows } from "./parse.js";
import { parseSheetId, type SheetSource } from "./sheets.js";

export class SyncError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

/** Pulls the configured Sheet and applies it as a full snapshot (missing words get archived). */
export async function syncFromSheet(db: Db, source: SheetSource | null): Promise<ImportSummary> {
  if (!source) {
    throw new SyncError("Google service account is not configured (GOOGLE_SERVICE_ACCOUNT_JSON)", 503);
  }
  const { rows: settings } = await db.query<{ sheet_id: string | null }>("SELECT sheet_id FROM settings WHERE id = 1");
  const sheetId = settings[0]?.sheet_id;
  if (!sheetId) throw new SyncError("No sheet_id set. Set it with PUT /settings first.", 409);

  let raw: string[][];
  try {
    raw = await source.fetchRows(parseSheetId(sheetId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SyncError(`Could not read the Google Sheet: ${msg}. Is it shared with the service account?`, 502);
  }

  const { entries, skipped } = parseRows(raw);

  return db.transaction(async (tx) => {
    if (entries.length === 0) {
      const { rows } = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM words WHERE NOT archived");
      if (rows[0].n > 0) {
        // Guard against archiving everything because of a wrong/empty sheet.
        throw new SyncError("The Sheet has no words; refusing to archive all existing words.", 422);
      }
    }
    const summary = await applyImport(tx, entries, { archiveMissing: true, skipped });
    await tx.query("UPDATE settings SET last_sync_at = now() WHERE id = 1");
    return summary;
  });
}
