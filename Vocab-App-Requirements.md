# Vocab App — Requirements

Personal app to memorise words saved in Google Translate, using spaced repetition flashcards.

## Goal

Turn words saved in Google Translate (mostly English → Ukrainian) into flashcards and review them in short sessions on the phone, e.g. on the tram commute.

## Users and platform

- Single user (personal tool). No multi-user or public sign-up.
- Phone-first Progressive Web App (installable to home screen), also usable on desktop.
- Online-only. No offline mode needed.
- No push notifications. The user opens the app when they want to study.

## Word import

- Source: Google Translate saved words, exported manually by the user to a Google Sheet (translate.google.com → Saved → Export to Google Sheets).
- The backend reads the Sheet with a Google service account. The user shares the Sheet once with the service account email. No Google login in the app.
- Sync triggers: a "Sync now" button in the app, plus an automatic daily sync (cron).
- Deduplicate on the English word (normalised: trimmed, lowercased).
- Words removed from the Sheet are archived, not deleted, so review history is kept.
- Rows in a language pair other than English → Ukrainian go into a separate "Other" deck.
- Fallback: manual CSV upload with the same columns as the Sheet export.

## Learning method

- Spaced repetition with the FSRS algorithm (use the `ts-fsrs` library).
- Each word produces two cards, scheduled independently:
  - English → Ukrainian (recognition)
  - Ukrainian → English (production)
- Ratings: Again / Hard / Good / Easy.
- Daily limit of new cards (default 20, configurable). Due reviews are not capped.

## Review session

- The app opens straight into the review queue.
- Sessions can be any length. The user can stop at any time and progress is saved after every card.
- Card flow: show the front, tap to reveal the back, rate.
- Pronunciation audio for the English side using the browser Web Speech API (speechSynthesis, en voice):
  - plays automatically when English text is shown
  - replay button on the card
- Large touch targets, usable one-handed.

## Progress screen (v1)

- Cards due today
- Total words learned
- Study streak (consecutive days with at least one review)

## Tech stack

- Language: TypeScript end to end.
- Frontend: React PWA (Vite, service worker for installability only).
- Backend: Node.js REST API (e.g. Express or Fastify).
- Database: Postgres (e.g. Supabase used as a managed database).
- Google Sheets API via `googleapis` with a service account.
- Daily sync via a scheduled job (cron).
- Auth: simple single-user protection (e.g. one password or a magic link) so the deployed app isn't public.

## Data model (initial)

- `words`: id, source\_text, target\_text, source\_lang, target\_lang, deck, archived, created\_at, sheet\_row\_key
- `cards`: id, word\_id, direction (en\_uk / uk\_en), FSRS state fields (due, stability, difficulty, elapsed\_days, scheduled\_days, reps, lapses, state, last\_review)
- `review_logs`: id, card\_id, rating, reviewed\_at, FSRS log fields
- `settings`: new\_cards\_per\_day, sheet\_id, last\_sync\_at

## API (initial)

- `POST /sync` — pull from the Sheet now
- `POST /import/csv` — CSV fallback import
- `GET /queue` — next due and new cards
- `POST /reviews` — submit a rating for a card
- `GET /stats` — due today, words learned, streak
- `GET/PUT /settings`

## Out of scope for v1 (possible later)

- Detailed statistics and charts
- Typing answers, multiple choice, listening exercises
- AI-generated example sentences and usage notes
- Offline mode
- Notifications
- Multi-user support

## Suggested build order

1. Database schema and Node API skeleton
2. Google Sheet sync with dedupe and archiving, plus CSV import
3. FSRS scheduling and review endpoints
4. React review screen with audio
5. Progress screen and settings
6. Single-user auth, PWA manifest, deployment
