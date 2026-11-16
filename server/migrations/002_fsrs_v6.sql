-- Align card/log columns with ts-fsrs v6 (FSRS-7) and add what the review queue needs.
-- ts-fsrs v6 card: stability, stabilityFast, difficulty, state, scheduleStatus, dueAt,
-- lastReviewAt, reps, lapses, scheduledDays (fractional), learningStep. No elapsed_days.

ALTER TABLE cards ADD COLUMN stability_fast double precision NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN schedule_status text NOT NULL DEFAULT 'new'
  CHECK (schedule_status IN ('new', 'learning', 'review'));
ALTER TABLE cards ALTER COLUMN scheduled_days TYPE double precision;
ALTER TABLE cards DROP COLUMN elapsed_days;

-- Review log = card state *before* the review, plus rating and time.
ALTER TABLE review_logs ADD COLUMN stability_fast double precision NOT NULL DEFAULT 0;
ALTER TABLE review_logs ADD COLUMN schedule_status text NOT NULL DEFAULT 'new';
ALTER TABLE review_logs ADD COLUMN last_review timestamptz;
ALTER TABLE review_logs ALTER COLUMN scheduled_days TYPE double precision;
ALTER TABLE review_logs DROP COLUMN elapsed_days;
ALTER TABLE review_logs DROP COLUMN last_elapsed_days;
-- Lets the client retry a review safely (flaky mobile connection) without double-counting.
ALTER TABLE review_logs ADD COLUMN client_review_id uuid UNIQUE;
ALTER TABLE review_logs ADD COLUMN duration_ms integer CHECK (duration_ms >= 0);

-- Day boundaries for the new-card limit (and streaks later) use the user's timezone.
ALTER TABLE settings ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';
