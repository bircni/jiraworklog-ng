import { describe, expect, it } from "vitest";
import {
  parseRangeKind,
  rangeQuery,
  resolveRange,
  shiftRange,
  type SprintConfig,
} from "@/lib/report-range";

const SPRINT: SprintConfig = { anchorDate: "2026-01-07", lengthDays: 14 };
const NOW = new Date(2026, 5, 15, 10, 0, 0); // 2026-06-15

/** Local Y-M-D parts of a Date, for TZ-independent assertions. */
function ymd(d: Date): [number, number, number] {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

describe("parseRangeKind", () => {
  it("passes through known kinds and defaults unknown to month", () => {
    expect(parseRangeKind("week")).toBe("week");
    expect(parseRangeKind("all")).toBe("all");
    expect(parseRangeKind("bogus")).toBe("month");
    expect(parseRangeKind(null)).toBe("month");
    expect(parseRangeKind(undefined)).toBe("month");
  });
});

describe("resolveRange — month", () => {
  const r = resolveRange("month", "2026-05-15", NOW, SPRINT);

  it("spans the whole calendar month", () => {
    expect(ymd(r.from)).toEqual([2026, 5, 1]);
    expect(r.from.getHours()).toBe(0);
    expect(ymd(r.to)).toEqual([2026, 5, 31]);
    expect(r.to.getHours()).toBe(23);
    expect(r.slug).toBe("2026-05");
    expect(r.anchor).toBe("2026-05-01");
    expect(r.label).toBe("Mai 2026");
    expect(r.navigable).toBe(true);
  });
});

describe("resolveRange — week", () => {
  const r = resolveRange("week", "2026-05-20", NOW, SPRINT); // a Wednesday

  it("spans Monday..Sunday of the anchor's week", () => {
    expect(r.from.getDay()).toBe(1); // Monday
    expect(r.anchor).toBe(
      `${r.from.getFullYear()}-${String(r.from.getMonth() + 1).padStart(2, "0")}-${String(
        r.from.getDate(),
      ).padStart(2, "0")}`,
    );
    expect(r.to.getDay()).toBe(0); // Sunday
    // Monday 00:00 .. Sunday 23:59:59.999 → 6 full 24h periods plus the tail.
    const spanDays = Math.floor((r.to.getTime() - r.from.getTime()) / 86_400_000);
    expect(spanDays).toBe(6);
    expect(r.from <= new Date(2026, 4, 20)).toBe(true);
    expect(new Date(2026, 4, 20) <= r.to).toBe(true);
    expect(r.slug).toMatch(/^\d{4}-W\d{2}$/);
    expect(r.navigable).toBe(true);
  });
});

describe("resolveRange — sprint", () => {
  it("aligns to the sprint grid from the config anchor", () => {
    const first = resolveRange("sprint", "2026-01-07", NOW, SPRINT);
    expect(ymd(first.from)).toEqual([2026, 1, 7]);
    expect(ymd(first.to)).toEqual([2026, 1, 20]);
    expect(first.sprintLengthDays).toBe(14);

    const second = resolveRange("sprint", "2026-01-21", NOW, SPRINT);
    expect(ymd(second.from)).toEqual([2026, 1, 21]);
    expect(ymd(second.to)).toEqual([2026, 2, 3]);
  });
});

describe("resolveRange — ytd / all", () => {
  it("runs Jan 1 .. now for the current year", () => {
    const r = resolveRange("ytd", "2026-03-01", NOW, SPRINT);
    expect(ymd(r.from)).toEqual([2026, 1, 1]);
    expect(ymd(r.to)).toEqual([2026, 6, 15]);
    expect(r.label).toBe("YTD 2026");
    expect(r.slug).toBe("ytd-2026");
  });

  it("runs the full calendar year for a past year", () => {
    const r = resolveRange("ytd", "2025-03-01", NOW, SPRINT);
    expect(ymd(r.from)).toEqual([2025, 1, 1]);
    expect(ymd(r.to)).toEqual([2025, 12, 31]);
    expect(r.label).toBe("Jahr 2025");
    expect(r.slug).toBe("jahr-2025");
  });

  it("marks `all` as non-navigable with an open start", () => {
    const r = resolveRange("all", null, NOW, SPRINT);
    expect(ymd(r.from)).toEqual([2000, 1, 1]);
    expect(ymd(r.to)).toEqual([2026, 6, 15]);
    expect(r.navigable).toBe(false);
    expect(r.anchor).toBe("");
  });
});

describe("shiftRange", () => {
  it("steps by the right unit per kind and returns null for `all`", () => {
    const month = resolveRange("month", "2026-05-15", NOW, SPRINT);
    expect(shiftRange(month, 1)).toBe("2026-06-01");
    expect(shiftRange(month, -1)).toBe("2026-04-01");

    const sprint = resolveRange("sprint", "2026-01-07", NOW, SPRINT);
    expect(shiftRange(sprint, 1)).toBe("2026-01-21");

    const ytd = resolveRange("ytd", "2026-03-01", NOW, SPRINT);
    expect(shiftRange(ytd, 1)).toBe("2027-01-01");

    const all = resolveRange("all", null, NOW, SPRINT);
    expect(shiftRange(all, 1)).toBeNull();
  });
});

describe("rangeQuery", () => {
  it("includes the anchor except for `all`", () => {
    expect(rangeQuery("month", "2026-05-01")).toBe("?range=month&anchor=2026-05-01");
    expect(rangeQuery("all", "")).toBe("?range=all");
  });
});
