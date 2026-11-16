import type { Queryable } from "../db.js";
import type { WordEntry } from "./parse.js";

export interface ImportSummary {
  /** Entries in the source after parsing and dedupe. */
  total: number;
  added: number;
  updated: number;
  /** Previously archived words that are back in the source. */
  restored: number;
  /** Words missing from the source that were archived (only when archiveMissing). */
  archived: number;
  unchanged: number;
  skipped: number;
}

interface ExistingWord {
  id: string;
  sheet_row_key: string;
  source_text: string;
  target_text: string;
  archived: boolean;
}

/**
 * Upserts entries into words (+ two cards per new word).
 * With archiveMissing, active words not in entries are archived (the source is a full snapshot).
 * Must run inside a transaction.
 */
export async function applyImport(
  tx: Queryable,
  entries: WordEntry[],
  opts: { archiveMissing: boolean; skipped?: number },
): Promise<ImportSummary> {
  // Serialise concurrent imports (manual sync vs. cron vs. CSV).
  await tx.query("SELECT pg_advisory_xact_lock(727001)");

  const { rows: existing } = await tx.query<ExistingWord>(
    "SELECT id, sheet_row_key, source_text, target_text, archived FROM words",
  );
  const byKey = new Map(existing.map((w) => [w.sheet_row_key, w]));

  const toInsert: WordEntry[] = [];
  const toUpdate: Array<{ id: string; source_text: string; target_text: string }> = [];
  const toRestore: string[] = [];
  let unchanged = 0;

  for (const e of entries) {
    const w = byKey.get(e.key);
    if (!w) {
      toInsert.push(e);
      continue;
    }
    byKey.delete(e.key);
    const changed = w.source_text !== e.source_text || w.target_text !== e.target_text;
    if (changed) toUpdate.push({ id: w.id, source_text: e.source_text, target_text: e.target_text });
    if (w.archived) toRestore.push(w.id);
    if (!changed && !w.archived) unchanged++;
  }

  const toArchive = opts.archiveMissing ? [...byKey.values()].filter((w) => !w.archived).map((w) => w.id) : [];

  if (toInsert.length) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO words (source_text, target_text, source_lang, target_lang, deck, sheet_row_key)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       RETURNING id`,
      [
        toInsert.map((e) => e.source_text),
        toInsert.map((e) => e.target_text),
        toInsert.map((e) => e.source_lang),
        toInsert.map((e) => e.target_lang),
        toInsert.map((e) => e.deck),
        toInsert.map((e) => e.key),
      ],
    );
    // Two cards per word: en_uk = source -> target (recognition), uk_en = target -> source (production).
    await tx.query(
      `INSERT INTO cards (word_id, direction)
       SELECT w.id, d.direction FROM unnest($1::uuid[]) AS w(id)
       CROSS JOIN (VALUES ('en_uk'), ('uk_en')) AS d(direction)`,
      [rows.map((r) => r.id)],
    );
  }

  if (toUpdate.length) {
    await tx.query(
      `UPDATE words SET source_text = u.source_text, target_text = u.target_text
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS u(id, source_text, target_text)
       WHERE words.id = u.id`,
      [toUpdate.map((u) => u.id), toUpdate.map((u) => u.source_text), toUpdate.map((u) => u.target_text)],
    );
  }

  if (toRestore.length) {
    await tx.query("UPDATE words SET archived = false WHERE id = ANY($1::uuid[])", [toRestore]);
  }
  if (toArchive.length) {
    await tx.query("UPDATE words SET archived = true WHERE id = ANY($1::uuid[])", [toArchive]);
  }

  return {
    total: entries.length,
    added: toInsert.length,
    updated: toUpdate.length,
    restored: toRestore.length,
    archived: toArchive.length,
    unchanged,
    skipped: opts.skipped ?? 0,
  };
}
