-- Initial schema: words, cards (FSRS state), review_logs, settings.

CREATE TABLE words (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_text   text NOT NULL,
  target_text   text NOT NULL,
  source_lang   text NOT NULL,
  target_lang   text NOT NULL,
  deck          text NOT NULL DEFAULT 'main' CHECK (deck IN ('main', 'other')),
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Normalised dedupe key set by the importer (trimmed, lowercased English word).
  sheet_row_key text NOT NULL UNIQUE
);

CREATE TABLE cards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  word_id        uuid NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  direction      text NOT NULL CHECK (direction IN ('en_uk', 'uk_en')),
  -- FSRS card state (mirrors ts-fsrs Card)
  due            timestamptz NOT NULL DEFAULT now(),
  stability      double precision NOT NULL DEFAULT 0,
  difficulty     double precision NOT NULL DEFAULT 0,
  elapsed_days   integer NOT NULL DEFAULT 0,
  scheduled_days integer NOT NULL DEFAULT 0,
  learning_steps integer NOT NULL DEFAULT 0,
  reps           integer NOT NULL DEFAULT 0,
  lapses         integer NOT NULL DEFAULT 0,
  state          smallint NOT NULL DEFAULT 0 CHECK (state BETWEEN 0 AND 3), -- 0 New, 1 Learning, 2 Review, 3 Relearning
  last_review    timestamptz,
  UNIQUE (word_id, direction)
);

CREATE INDEX cards_due_idx ON cards (due);
CREATE INDEX cards_state_idx ON cards (state);

CREATE TABLE review_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id           uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating            smallint NOT NULL CHECK (rating BETWEEN 1 AND 4), -- 1 Again, 2 Hard, 3 Good, 4 Easy
  reviewed_at       timestamptz NOT NULL DEFAULT now(),
  -- FSRS log fields (mirrors ts-fsrs ReviewLog)
  state             smallint NOT NULL,
  due               timestamptz NOT NULL,
  stability         double precision NOT NULL,
  difficulty        double precision NOT NULL,
  elapsed_days      integer NOT NULL,
  last_elapsed_days integer NOT NULL,
  scheduled_days    integer NOT NULL,
  learning_steps    integer NOT NULL DEFAULT 0
);

CREATE INDEX review_logs_card_idx ON review_logs (card_id);
CREATE INDEX review_logs_reviewed_at_idx ON review_logs (reviewed_at);

-- Single-row settings table.
CREATE TABLE settings (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  new_cards_per_day integer NOT NULL DEFAULT 20 CHECK (new_cards_per_day >= 0),
  sheet_id          text,
  last_sync_at      timestamptz
);

INSERT INTO settings (id) VALUES (1);
