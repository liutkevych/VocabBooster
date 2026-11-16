import path from "node:path";
import { Cron } from "croner";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createGoogleSheetSource } from "./importer/sheets.js";
import { syncFromSheet } from "./importer/sync.js";
import { migrate } from "./migrate.js";
import { openDb } from "./open-db.js";
import { createScheduler } from "./srs/scheduler.js";

const config = loadConfig();
const db = await openDb(config);
await migrate(db);

const sheetSource = createGoogleSheetSource();
const scheduler = await createScheduler();
const app = buildApp(db, {
  logger: true,
  sheetSource,
  scheduler,
  auth: config.auth,
  webRoot: config.webRoot ? path.resolve(config.webRoot) : undefined,
  trustProxyHops: config.production ? 1 : undefined, // Fly.io's proxy
});

if (!config.auth) app.log.warn("APP_PASSWORD not set: the API is open (fine for local development only)");

let job: Cron | undefined;
if (sheetSource) {
  job = new Cron(config.syncCron, { timezone: config.syncTimezone, protect: true }, async () => {
    try {
      const summary = await syncFromSheet(db, sheetSource);
      app.log.info({ summary }, "daily sync done");
    } catch (err) {
      app.log.error({ err }, "daily sync failed");
    }
  });
  app.log.info(`daily sync scheduled: "${config.syncCron}" (${config.syncTimezone}), next ${job.nextRun()?.toISOString()}`);
} else {
  app.log.warn("Google service account not configured: Sheet sync disabled");
}

const shutdown = async () => {
  job?.stop();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
