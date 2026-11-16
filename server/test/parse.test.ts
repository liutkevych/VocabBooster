import { describe, expect, it } from "vitest";
import { parseRows } from "../src/importer/parse.js";
import { parseSheetId } from "../src/importer/sheets.js";

describe("parseRows", () => {
  it("parses English → Ukrainian rows into the main deck", () => {
    const { entries, skipped } = parseRows([["English", "Ukrainian", "  Hello ", "привіт"]]);
    expect(skipped).toBe(0);
    expect(entries).toEqual([
      { source_text: "Hello", target_text: "привіт", source_lang: "en", target_lang: "uk", deck: "main", key: "hello" },
    ]);
  });

  it("flips Ukrainian → English rows so English is the source", () => {
    const { entries } = parseRows([["Ukrainian", "English", "кіт", "Cat"]]);
    expect(entries[0]).toMatchObject({ source_text: "Cat", target_text: "кіт", deck: "main", key: "cat" });
  });

  it("dedupes on the normalised English word, first row wins", () => {
    const { entries, skipped } = parseRows([
      ["English", "Ukrainian", "Run  out", "закінчитися"],
      ["en", "uk", "run out", "вибігти"],
      ["Ukrainian", "English", "закінчитися", "RUN OUT"],
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].target_text).toBe("закінчитися");
    expect(skipped).toBe(2);
  });

  it("puts other language pairs in the Other deck with their own keys", () => {
    const { entries } = parseRows([
      ["English", "German", "hello", "hallo"],
      ["English", "Ukrainian", "hello", "привіт"],
    ]);
    expect(entries.map((e) => [e.deck, e.key])).toEqual([
      ["other", "en>german:hello"],
      ["main", "hello"],
    ]);
  });

  it("skips a header row and blank or incomplete rows", () => {
    const { entries, skipped } = parseRows([
      ["Source language", "Target language", "Source text", "Translation"],
      [],
      ["", "", "", ""],
      ["English", "Ukrainian", "word", ""],
      ["English", "Ukrainian", "tree", "дерево"],
    ]);
    expect(entries.map((e) => e.key)).toEqual(["tree"]);
    expect(skipped).toBe(2);
  });
});

describe("parseSheetId", () => {
  it("extracts the ID from a URL or keeps a bare ID", () => {
    expect(parseSheetId("https://docs.google.com/spreadsheets/d/1AbC-d_E/edit#gid=0")).toBe("1AbC-d_E");
    expect(parseSheetId(" 1AbC-d_E ")).toBe("1AbC-d_E");
  });
});
