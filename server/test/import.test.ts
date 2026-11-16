import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import type { SheetSource } from "../src/importer/sheets.js";
import { createScheduler, type Scheduler } from "../src/srs/scheduler.js";
import { createTestDb } from "./helpers.js";

let db: Db;
let app: FastifyInstance;
let sheetRows: string[][];
let requestedId: string | undefined;
let failFetch: boolean;
let scheduler: Scheduler;

const fakeSheet: SheetSource = {
  async fetchRows(id) {
    requestedId = id;
    if (failFetch) throw new Error("The caller does not have permission");
    return sheetRows;
  },
};

beforeEach(async () => {
  db = await createTestDb();
  scheduler ??= await createScheduler();
  app = buildApp(db, { sheetSource: fakeSheet, scheduler, auth: null });
  sheetRows = [];
  requestedId = undefined;
  failFetch = false;
  await db.query("UPDATE settings SET sheet_id = 'https://docs.google.com/spreadsheets/d/SHEET123/edit'");
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const sync = () => app.inject({ method: "POST", url: "/api/sync" });
const words = async () =>
  (
    await db.query<{ sheet_row_key: string; target_text: string; archived: boolean; deck: string }>(
      "SELECT sheet_row_key, target_text, archived, deck FROM words ORDER BY sheet_row_key",
    )
  ).rows;

describe("POST /sync", () => {
  it("imports words, creates two cards each, and records last_sync_at", async () => {
    sheetRows = [
      ["English", "Ukrainian", "hello", "привіт"],
      ["English", "Ukrainian", "cat", "кіт"],
      ["English", "German", "dog", "Hund"],
    ];
    const res = await sync();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 3, added: 3, updated: 0, archived: 0 });
    expect(requestedId).toBe("SHEET123");

    const { rows: cards } = await db.query<{ direction: string; n: number }>(
      "SELECT direction, count(*)::int AS n FROM cards GROUP BY direction ORDER BY direction",
    );
    expect(cards).toEqual([
      { direction: "en_uk", n: 3 },
      { direction: "uk_en", n: 3 },
    ]);
    expect((await words()).find((w) => w.sheet_row_key === "en>german:dog")?.deck).toBe("other");
    const { rows } = await db.query<{ last_sync_at: Date | null }>("SELECT last_sync_at FROM settings");
    expect(rows[0].last_sync_at).not.toBeNull();
  });

  it("is idempotent, updates changed translations, archives and restores", async () => {
    sheetRows = [
      ["English", "Ukrainian", "hello", "привіт"],
      ["English", "Ukrainian", "cat", "кіт"],
    ];
    await sync();
    expect((await sync()).json()).toMatchObject({ added: 0, unchanged: 2 });

    // "cat" removed, "hello" translation changed
    sheetRows = [["English", "Ukrainian", "hello", "вітаю"]];
    expect((await sync()).json()).toMatchObject({ added: 0, updated: 1, archived: 1 });
    expect(await words()).toEqual([
      { sheet_row_key: "cat", target_text: "кіт", archived: true, deck: "main" },
      { sheet_row_key: "hello", target_text: "вітаю", archived: false, deck: "main" },
    ]);

    // "cat" comes back: restored, cards kept (no duplicates)
    sheetRows.push(["English", "Ukrainian", "Cat", "кіт"]);
    expect((await sync()).json()).toMatchObject({ added: 0, restored: 1, archived: 0 });
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM cards");
    expect(rows[0].n).toBe(4);
  });

  it("refuses to archive everything when the Sheet comes back empty", async () => {
    sheetRows = [["English", "Ukrainian", "hello", "привіт"]];
    await sync();
    sheetRows = [];
    const res = await sync();
    expect(res.statusCode).toBe(422);
    expect((await words())[0].archived).toBe(false);
  });

  it("reports a clear error when the Sheet can't be read", async () => {
    failFetch = true;
    const res = await sync();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/shared with the service account/);
  });

  it("needs a sheet_id and a configured service account", async () => {
    await db.query("UPDATE settings SET sheet_id = NULL");
    expect((await sync()).statusCode).toBe(409);

    const noGoogle = buildApp(db, { sheetSource: null, scheduler, auth: null });
    const res = await noGoogle.inject({ method: "POST", url: "/api/sync" });
    expect(res.statusCode).toBe(503);
    await noGoogle.close();
  });
});

describe("POST /import/csv", () => {
  const postCsv = (payload: string) =>
    app.inject({ method: "POST", url: "/api/import/csv", headers: { "content-type": "text/csv" }, payload });

  it("imports quoted CSV rows additively (never archives)", async () => {
    sheetRows = [["English", "Ukrainian", "hello", "привіт"]];
    await sync();

    const res = await postCsv('﻿English,Ukrainian,"look up, search","шукати"\nEnglish,Ukrainian,tree,дерево\n');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 2, added: 2, archived: 0 });
    expect((await words()).map((w) => [w.sheet_row_key, w.archived])).toEqual([
      ["hello", false],
      ["look up, search", false],
      ["tree", false],
    ]);
  });

  it("rejects an empty body or malformed CSV", async () => {
    expect((await postCsv("")).statusCode).toBe(400);
    expect((await postCsv('a,"b\nc')).statusCode).toBe(400);
  });
});
