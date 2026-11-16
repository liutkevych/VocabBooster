/**
 * Turns rows from a Google Translate "Saved" export into word entries.
 *
 * The export has four columns and no header:
 *   source language | target language | source text | translation
 * Languages are display names ("English", "Ukrainian"); codes ("en", "uk") are accepted too.
 */

export type Deck = "main" | "other";

export interface WordEntry {
  source_text: string;
  target_text: string;
  source_lang: string;
  target_lang: string;
  deck: Deck;
  /** Dedupe key: the normalised English word for the main deck. */
  key: string;
}

export interface ParseResult {
  entries: WordEntry[];
  /** Rows that were blank, malformed, a header, or a duplicate of an earlier row. */
  skipped: number;
}

const LANG_ALIASES: Record<string, string> = {
  english: "en",
  "англійська": "en",
  ukrainian: "uk",
  "українська": "uk",
};

export function normalizeLang(value: string): string {
  const v = value.trim().toLowerCase();
  return LANG_ALIASES[v] ?? v;
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isHeader(row: string[]): boolean {
  const cells = row.map((c) => c.trim().toLowerCase());
  return cells.some((c) => /^(source|target) (language|text)$|^translation$/.test(c));
}

export function parseRows(rows: string[][]): ParseResult {
  const byKey = new Map<string, WordEntry>();
  let skipped = 0;

  rows.forEach((raw, i) => {
    const row = raw.map((c) => (c ?? "").toString());
    const [srcLangRaw = "", tgtLangRaw = "", srcRaw = "", tgtRaw = ""] = row;
    const sourceText = srcRaw.trim().replace(/\s+/g, " ");
    const targetText = tgtRaw.trim().replace(/\s+/g, " ");

    if ((i === 0 && isHeader(row)) || !sourceText || !targetText || !srcLangRaw.trim() || !tgtLangRaw.trim()) {
      if (row.some((c) => c.trim())) skipped++;
      return;
    }

    const srcLang = normalizeLang(srcLangRaw);
    const tgtLang = normalizeLang(tgtLangRaw);

    let entry: WordEntry;
    if (srcLang === "en" && tgtLang === "uk") {
      entry = { source_text: sourceText, target_text: targetText, source_lang: "en", target_lang: "uk", deck: "main", key: normalizeText(sourceText) };
    } else if (srcLang === "uk" && tgtLang === "en") {
      // Same pair looked up the other way: flip it so the English word is the source.
      entry = { source_text: targetText, target_text: sourceText, source_lang: "en", target_lang: "uk", deck: "main", key: normalizeText(targetText) };
    } else {
      entry = {
        source_text: sourceText,
        target_text: targetText,
        source_lang: srcLang,
        target_lang: tgtLang,
        deck: "other",
        key: `${srcLang}>${tgtLang}:${normalizeText(sourceText)}`,
      };
    }

    if (byKey.has(entry.key)) {
      skipped++; // first occurrence wins (Google Translate lists newest first)
      return;
    }
    byKey.set(entry.key, entry);
  });

  return { entries: [...byKey.values()], skipped };
}
