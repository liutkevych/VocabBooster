# Vocab Booster

Personal spaced-repetition flashcards for words saved in Google Translate. See `Vocab-App-Requirements.md`.

- `server/`: Node.js + Fastify API, Postgres, FSRS scheduling, login ([server/README.md](server/README.md))
- `web/`: React review app, installable to the home screen (Vite)

## Run locally (no Postgres needed)

```sh
npm install
cp server/.env.example server/.env   # embedded Postgres in server/.data, no password
npm run dev:server      # API on http://localhost:3000
npm run dev:web         # app on http://localhost:5173 (forwards /api to the server)
```

Add words: `curl -X POST localhost:3000/api/import/csv -H 'content-type: text/csv' --data-binary @words.csv`,
or Settings → Import a CSV file.

Review shortcuts on desktop: Space shows the answer, 1–4 rate (Again, Hard, Good, Easy).

```sh
npm test         # server + web tests
npm run build
```

## Deploy to Fly.io + Supabase

One always-on 256 MB machine on Fly.io serves the app and the API; Supabase's free plan hosts Postgres.
There are no backups: if the Supabase project is deleted, review history is lost (the words themselves can be
synced again from the Sheet).

**Cost:** about $2.30/month for the Fly.io machine (Amsterdam). Fly.io waives personal bills under $5, so in
practice $0 while that policy lasts. Fly.io needs a credit card after its trial. Supabase free plan: $0.

### 1. Supabase (database)

1. Create a project at [supabase.com](https://supabase.com). Choose a region near Amsterdam, e.g. Frankfurt
   (`eu-central-1`). Save the database password.
2. Click **Connect** and copy the **Session pooler** connection string. It works over IPv4 and looks like
   `postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`.
   Put your database password in it. No `?sslmode=...` needed; the server sets up TLS itself.
3. **Project Settings → Database → SSL Configuration → Download certificate**. This is the CA the server uses to
   verify it's really talking to Supabase.

The server creates its tables on first start; nothing to run in Supabase's SQL editor.

### 2. Google service account (for Sheet sync)

See [server/README.md](server/README.md#google-sheet-sync). Keep the downloaded JSON key file at hand. You can skip
this and use CSV import only; the app works without it.

### 3. Fly.io (server)

```sh
brew install flyctl          # or see https://fly.io/docs/flyctl/install/
fly auth signup              # or: fly auth login

# Pick a unique app name and put it in fly.toml (app = "..."), then:
fly apps create <your-app-name>

fly secrets set \
  DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' \
  DATABASE_SSL_CA="$(cat ~/Downloads/prod-ca-2021.crt)" \
  APP_PASSWORD='<a password you can type on your phone, 8+ characters>' \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  GOOGLE_SERVICE_ACCOUNT_JSON="$(cat ~/Downloads/<your-key>.json)"

fly deploy --ha=false        # --ha=false: one machine (Fly.io otherwise creates two)
```

Use the certificate file name you downloaded in step 1.3. Leave out `GOOGLE_SERVICE_ACCOUNT_JSON` if you skipped
step 2.

Then open `https://<your-app-name>.fly.dev`, sign in, and in **Settings** set your timezone, paste the Sheet link,
Save, and **Sync now**.

If the database connection fails with a certificate error, check `DATABASE_SSL_CA`. As a last resort,
`fly secrets set DATABASE_SSL=no-verify` keeps the connection encrypted but stops checking the certificate.

### 4. Install on your phone

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Install app (or Add to Home screen).

It opens full screen like an app. You stay signed in for a year on each device.

### Day to day

| Task | Command |
| --- | --- |
| Deploy a new version | `fly deploy` |
| See logs (sync results, errors) | `fly logs` |
| Change the password (signs out all devices) | `fly secrets set APP_PASSWORD='...'` |
| Check it's one machine, running | `fly status` |
