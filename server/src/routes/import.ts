import type { FastifyPluginAsync } from "fastify";
import { parse as parseCsv } from "csv-parse/sync";
import type { Db } from "../db.js";
import { applyImport } from "../importer/apply.js";
import { parseRows } from "../importer/parse.js";
import type { SheetSource } from "../importer/sheets.js";
import { syncFromSheet } from "../importer/sync.js";

export const importRoutes =
  (db: Db, sheetSource: SheetSource | null): FastifyPluginAsync =>
  async (app) => {
    app.post("/sync", async () => syncFromSheet(db, sheetSource));

    // CSV fallback: send the file as the raw request body (Content-Type: text/csv).
    // Additive only: words missing from the CSV are not archived.
    app.addContentTypeParser(["text/csv", "text/plain"], { parseAs: "string", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) =>
      done(null, body),
    );

    app.post("/import/csv", async (req, reply) => {
      if (typeof req.body !== "string" || !req.body.trim()) {
        return reply.code(400).send({ error: "Send the CSV as the request body with Content-Type: text/csv" });
      }
      let rows: string[][];
      try {
        rows = parseCsv(req.body.replace(/^﻿/, ""), { relax_column_count: true, skip_empty_lines: true });
      } catch (err) {
        return reply.code(400).send({ error: `Invalid CSV: ${(err as Error).message}` });
      }
      const { entries, skipped } = parseRows(rows);
      return db.transaction((tx) => applyImport(tx, entries, { archiveMissing: false, skipped }));
    });
  };
