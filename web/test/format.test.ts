import { describe, expect, it } from "vitest";
import { formatInterval, formatUntil } from "../src/format";

const now = Date.parse("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();
const MIN = 60_000;
const DAY = 1440 * MIN;

describe("formatInterval", () => {
  it.each([
    [20_000, "<1m"],
    [55_000, "1m"], // a 1m step seen a few seconds after the queue loaded
    [MIN, "1m"],
    [10 * MIN, "10m"],
    [3 * 60 * MIN, "3h"],
    [4 * DAY, "4d"],
    [65 * DAY, "2mo"],
    [550 * DAY, "1.5y"],
  ])("%d ms -> %s", (ms, label) => {
    expect(formatInterval(at(ms), now)).toBe(label);
  });
});

describe("formatUntil", () => {
  it("rounds up to minutes, then hours", () => {
    expect(formatUntil(at(30_000), now)).toBe("in a minute");
    expect(formatUntil(at(6.2 * MIN), now)).toBe("in 7 min");
    expect(formatUntil(at(130 * MIN), now)).toBe("in 2 h");
  });
});
