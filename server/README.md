# Vocab server

Node.js + Fastify REST API backed by Postgres. In production it also serves the built web app.

```sh
cp .env.example .env      # defaults to an embedded local Postgres (PGlite), no setup needed
npm install
npm run dev               # start on PORT (default 3000); migrates on startup
npm run migrate           # apply SQL migrations in migrations/ without starting the server
npm test                  # runs against in-memory Postgres (PGlite), no DB needed
```

## Endpoints

All under `/api`. Everything except `health` and `auth/*` needs a session when `APP_PASSWORD` is set.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/health` | Health check (also used by Fly.io) |
| GET | `/api/auth/me` | `{authenticated, required}` |
| POST | `/api/auth/login` | `{password}`: sets the session cookie |
| POST | `/api/auth/logout` | Clears the session cookie |
| GET / PUT | `/api/settings` | New cards per day, Sheet ID, timezone |
| POST | `/api/sync` | Pull the Sheet now (full snapshot, archives missing words) |
| POST | `/api/import/csv` | Raw CSV body, `Content-Type: text/csv` (adds and updates, never archives) |
| GET | `/api/queue?deck=main\|other&limit=50` | Due cards and today's new cards, with when each rating would bring them back |
| POST | `/api/reviews` | `{card_id, rating 1-4, client_review_id?, duration_ms?}` |
| GET | `/api/stats?deck=main\|other` | Due today, words learned, streak |

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Postgres URL, or `pglite:<folder>` for an embedded local database (development only) |
| `DATABASE_SSL` | `verify` in production, else `off` | `verify` checks the server certificate, `no-verify` encrypts without checking it, `off` disables TLS |
| `DATABASE_SSL_CA` | | Extra CA certificate (PEM) to trust, e.g. Supabase's |
| `APP_PASSWORD` | | Turns on login. Required in production, at least 8 characters |
| `SESSION_SECRET` | | Signs session cookies. Required with `APP_PASSWORD`, at least 32 characters |
| `NODE_ENV` | | `production`: requires the password, Secure cookies, trusts Fly.io's proxy for the client IP |
| `WEB_ROOT` | | Folder of the built web app to serve at `/` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | | Service account key JSON (or `GOOGLE_APPLICATION_CREDENTIALS` = path to the key file) |
| `SYNC_CRON` / `SYNC_TIMEZONE` | `0 4 * * *` / `UTC` | When the daily Sheet sync runs |
| `PORT` | `3000` | |

Changing `APP_PASSWORD` or `SESSION_SECRET` signs out every device.

## Login

One password, no user accounts. A successful login sets a signed `HttpOnly; Secure; SameSite=Strict` cookie
valid for a year, so each device signs in once. After 5 wrong passwords from one IP, login is blocked for 15 minutes.

## Google Sheet sync

1. In Google Cloud, create a service account, enable the Google Sheets API, and download a JSON key.
2. Set the key as `GOOGLE_SERVICE_ACCOUNT_JSON` (or point `GOOGLE_APPLICATION_CREDENTIALS` at the file).
3. Share your exported Sheet (Viewer) with the service account's email.
4. In the app: Settings → paste the Sheet link → Save → Sync now.

The server also syncs daily on `SYNC_CRON` in `SYNC_TIMEZONE`.

Expected columns (Google Translate export, no header): source language, target language, source text, translation.
English → Ukrainian and Ukrainian → English rows go to the main deck, keyed on the trimmed, lowercased English word.
Other pairs go to the "other" deck.

## Scheduling (FSRS)

`ts-fsrs` v6 `DefaultScheduler` (FSRS-7), 90% target retention, fuzz on, max interval 5 years.
New and lapsed cards go through short learning steps (new: 1m, 10m; lapsed: 10m) before day intervals.

`GET /api/queue` order: due learning cards first, then due reviews with new cards spread among them.
- New cards count against `new_cards_per_day`, reset at midnight in the `timezone` setting.
- A word's Ukrainian → English card unlocks the day after its English → Ukrainian card is first reviewed.
- When nothing is due, learning cards due within 20 minutes are served early; `next_due_at` says when to check back.

`POST /api/reviews` with the same `client_review_id` is safe to retry: it won't count twice.
