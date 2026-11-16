import { DefaultScheduler, type Grade } from "ts-fsrs";

/**
 * FSRS scheduler (ts-fsrs v6, FSRS-7 model).
 * allowModelOverride=false keeps the short learning steps (1m, 10m) for new and lapsed cards,
 * so a new word is seen a few times in the same session before moving to day intervals.
 */
export async function createScheduler(opts: { enableFuzz?: boolean } = {}) {
  return DefaultScheduler({
    desiredRetention: 0.9,
    enableShortTerm: true,
    allowModelOverride: false,
    learningSteps: ["1m", "10m"],
    relearningSteps: ["10m"],
    enableFuzz: opts.enableFuzz ?? true,
    maximumInterval: 365 * 5,
  });
}

export type Scheduler = Awaited<ReturnType<typeof createScheduler>>;
type SchedulerCard = Parameters<Scheduler["review"]>[0]["card"];

/** Columns of `cards` that hold FSRS state. */
export interface CardRow {
  id: string;
  due: Date;
  stability: number;
  stability_fast: number;
  difficulty: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  schedule_status: string;
  last_review: Date | null;
}

export const CARD_STATE_COLUMNS =
  "due, stability, stability_fast, difficulty, scheduled_days, learning_steps, reps, lapses, state, schedule_status, last_review";

export function toFsrsCard(row: CardRow): SchedulerCard {
  return {
    cardId: row.id,
    dueAt: new Date(row.due),
    stability: row.stability,
    stabilityFast: row.stability_fast,
    difficulty: row.difficulty,
    scheduledDays: row.scheduled_days,
    learningStep: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    scheduleStatus: row.schedule_status,
    lastReviewAt: row.last_review ? new Date(row.last_review) : null,
  } as SchedulerCard;
}

export function reviewCard(scheduler: Scheduler, row: CardRow, rating: Grade, now: Date) {
  const { card, revlog } = scheduler.review({ card: toFsrsCard(row), grade: rating, now });
  return {
    /** New card state, as `cards` column values. */
    card: {
      due: card.dueAt,
      stability: card.stability,
      stability_fast: card.stabilityFast,
      difficulty: card.difficulty,
      scheduled_days: card.scheduledDays,
      learning_steps: card.learningStep,
      reps: card.reps,
      lapses: card.lapses,
      state: card.state,
      schedule_status: card.scheduleStatus,
      last_review: card.lastReviewAt,
    },
    /** State before the review, as `review_logs` column values. */
    log: {
      rating,
      reviewed_at: revlog.reviewTime,
      state: revlog.state,
      schedule_status: revlog.scheduleStatus,
      due: revlog.dueAt,
      stability: revlog.stability,
      stability_fast: revlog.stabilityFast,
      difficulty: revlog.difficulty,
      scheduled_days: revlog.scheduledDays,
      learning_steps: revlog.learningStep,
      last_review: revlog.lastReviewAt,
    },
  };
}

/** When each rating would make the card due next (for "1m / 10m / 5d / 21d" labels on the buttons). */
export function previewDue(scheduler: Scheduler, row: CardRow, now: Date): Record<Grade, string> {
  const out = {} as Record<Grade, string>;
  for (const { grade, card } of scheduler.preview({ card: toFsrsCard(row), now })) {
    out[grade as Grade] = card.dueAt.toISOString();
  }
  return out;
}
