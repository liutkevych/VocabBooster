const BASE = import.meta.env.VITE_API_URL ?? "/api";

export type Rating = 1 | 2 | 3 | 4;

export interface CardSide {
  text: string;
  lang: string;
}

export interface QueueCard {
  id: string;
  word_id: string;
  direction: "en_uk" | "uk_en";
  /** 0 New, 1 Learning, 2 Review, 3 Relearning */
  state: number;
  front: CardSide;
  back: CardSide;
  /** ISO due date for each rating, if chosen now. */
  preview: Record<Rating, string>;
}

export interface Queue {
  cards: QueueCard[];
  counts: { learning: number; review: number; new: number };
  new_limit: { per_day: number; introduced_today: number };
  next_due_at: string | null;
}

/** Fired on window when any API call comes back 401. */
export const UNAUTHORIZED_EVENT = "vocab:unauthorized";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    // Session missing or expired: the app shows the login screen.
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const body = await res.json().catch(() => ({}));
    // Validation errors carry the specific reason in issues[0].message.
    const detail = body.issues?.[0]?.message;
    throw new ApiError(detail ?? body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

export function fetchQueue(deck: "main" | "other" = "main"): Promise<Queue> {
  return request<Queue>(`/queue?deck=${deck}`);
}

export interface ReviewSubmission {
  card_id: string;
  rating: Rating;
  /** Makes retries safe: the server ignores a second submission with the same ID. */
  client_review_id: string;
  duration_ms?: number;
}

export function postReview(review: ReviewSubmission): Promise<unknown> {
  return request("/reviews", { method: "POST", body: JSON.stringify(review) });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries network errors and 5xx with backoff. 4xx means the request itself is wrong, so it fails at once. */
export async function postReviewWithRetry(review: ReviewSubmission, attempts = 5, baseDelayMs = 500): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await postReview(review);
      return;
    } catch (err) {
      const retryable = !(err instanceof ApiError) || err.status >= 500;
      if (!retryable || i >= attempts - 1) throw err;
      await wait(baseDelayMs * 2 ** i);
    }
  }
}

export interface Stats {
  today: string;
  timezone: string;
  due: { now: number; today: number; new_remaining: number };
  reviews_today: number;
  words: { total: number; learned: number; in_progress: number };
  streak: { days: number; studied_today: boolean };
}

export function fetchStats(deck: "main" | "other" = "main"): Promise<Stats> {
  return request<Stats>(`/stats?deck=${deck}`);
}

export interface Settings {
  new_cards_per_day: number;
  sheet_id: string | null;
  last_sync_at: string | null;
  timezone: string;
}

export function fetchSettings(): Promise<Settings> {
  return request<Settings>("/settings");
}

export function saveSettings(update: Partial<Omit<Settings, "last_sync_at">>): Promise<Settings> {
  return request<Settings>("/settings", { method: "PUT", body: JSON.stringify(update) });
}

export interface ImportSummary {
  total: number;
  added: number;
  updated: number;
  restored: number;
  archived: number;
  unchanged: number;
  skipped: number;
}

export function syncNow(): Promise<ImportSummary> {
  return request<ImportSummary>("/sync", { method: "POST", body: "{}" });
}

export function importCsv(csv: string): Promise<ImportSummary> {
  return request<ImportSummary>("/import/csv", { method: "POST", body: csv, headers: { "content-type": "text/csv" } });
}

export interface AuthStatus {
  authenticated: boolean;
  /** false when the server runs without a password (local development). */
  required: boolean;
}

export function fetchAuthStatus(): Promise<AuthStatus> {
  return request<AuthStatus>("/auth/me");
}

export function login(password: string): Promise<{ authenticated: boolean }> {
  return request("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
}

export function logout(): Promise<unknown> {
  return request("/auth/logout", { method: "POST", body: "{}" });
}
