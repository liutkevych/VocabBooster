import { loadConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { openDb } from "./open-db.js";

const db = await openDb(loadConfig());
try {
  const ran = await migrate(db);
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
} finally {
  await db.close();
}
