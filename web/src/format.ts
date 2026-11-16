/** Short interval label for a rating button: "1m", "10m", "3h", "4d", "2mo", "1.5y". */
export function formatInterval(dueIso: string, now = Date.now()): string {
  const ms = Math.max(0, new Date(dueIso).getTime() - now);
  const min = ms / 60_000;
  if (min < 0.5) return "<1m";
  if (min < 60) return `${Math.round(min)}m`;
  const hours = min / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  const years = days / 365;
  return `${years < 10 ? Math.round(years * 10) / 10 : Math.round(years)}y`;
}

/** "in 7 min", "in 2 h", or "tomorrow"-ish wording for when the next card is due. */
export function formatUntil(dueIso: string, now = Date.now()): string {
  const min = Math.ceil((new Date(dueIso).getTime() - now) / 60_000);
  if (min <= 1) return "in a minute";
  if (min < 60) return `in ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

/** "Added 3 · updated 1 · archived 2", or "No changes (120 words)". */
export function summarizeImport(s: {
  total: number;
  added: number;
  updated: number;
  restored: number;
  archived: number;
  skipped: number;
}): string {
  const parts = [
    s.added && `added ${s.added}`,
    s.updated && `updated ${s.updated}`,
    s.restored && `restored ${s.restored}`,
    s.archived && `archived ${s.archived}`,
  ].filter(Boolean) as string[];
  const main = parts.length ? parts.join(" · ") : `no changes (${s.total} ${s.total === 1 ? "word" : "words"})`;
  const skipped = s.skipped ? ` · ${s.skipped} skipped` : "";
  return main.charAt(0).toUpperCase() + main.slice(1) + skipped;
}
