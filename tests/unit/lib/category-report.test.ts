import { describe, expect, it } from "vitest";
import type { SettingsRow, TimeEntry } from "@/db/schema";
import { buildCategoryReport, splitIntoBlocks } from "@/lib/category-report";
import { resolveRange } from "@/lib/report-range";

const iso = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0).toISOString();

let idSeq = 1;
function entry(o: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: o.id ?? idSeq++,
    description: "",
    startedAt: iso(2026, 5, 18, 10, 0),
    endedAt: null,
    submittedAt: null,
    jiraIssueKey: null,
    isAllgemeines: false,
    category: null,
    createdAt: "",
    updatedAt: "",
    ...o,
  } as TimeEntry;
}

function settings(o: Partial<SettingsRow> = {}): SettingsRow {
  return {
    breaks: "[]",
    autoPauseEnabled: false,
    jiraUser: "tester@example.com",
    ...o,
  } as unknown as SettingsRow;
}

describe("splitIntoBlocks", () => {
  it("splits a duration into <= 24h (1440-minute) blocks", () => {
    expect(splitIntoBlocks(0)).toEqual([]);
    expect(splitIntoBlocks(100)).toEqual([100]);
    expect(splitIntoBlocks(1440)).toEqual([1440]);
    expect(splitIntoBlocks(1441)).toEqual([1440, 1]);
    expect(splitIntoBlocks(2880)).toEqual([1440, 1440]);
    expect(splitIntoBlocks(3000)).toEqual([1440, 1440, 120]);
  });
});

describe("buildCategoryReport", () => {
  const range = resolveRange("month", "2026-05-15", new Date(2026, 5, 15));

  it("aggregates categories within the range with per-day rows", () => {
    const report = buildCategoryReport(
      [
        // concrete → "Implementierung", 60 min
        entry({ description: "TXR-1 x", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 11, 0) }),
        // Allgemeines QA, 30 min
        entry({ startedAt: iso(2026, 5, 18, 12, 0), endedAt: iso(2026, 5, 18, 12, 30), isAllgemeines: true, category: "QA" }),
        // Allgemeines without a category → fallback "Projektorganisation", 15 min
        entry({ startedAt: iso(2026, 5, 19, 9, 0), endedAt: iso(2026, 5, 19, 9, 15), isAllgemeines: true, category: null }),
        // outside the May range → ignored
        entry({ startedAt: iso(2026, 6, 5, 9, 0), endedAt: iso(2026, 6, 5, 10, 0) }),
        // running → ignored
        entry({ startedAt: iso(2026, 5, 20, 9, 0), endedAt: null }),
      ],
      settings(),
      range,
    );

    expect(report.rangeLabel).toBe("Mai 2026");
    expect(report.displayName).toBe("tester@example.com");
    expect(report.totalMinutes).toBe(105);
    // Canonical category order, zero-time categories (Release) dropped.
    expect(report.categories.map((c) => [c.name, c.totalMinutes])).toEqual([
      ["Projektorganisation", 15],
      ["Implementierung", 60],
      ["QA", 30],
    ]);

    expect(report.days.map((d) => d.dayKey)).toEqual(["2026-05-18", "2026-05-19"]);
    const d18 = report.days[0];
    expect(d18.label).toBe("Mo 18.05.");
    expect(d18.minutesByCategory.Implementierung).toBe(60);
    expect(d18.minutesByCategory.QA).toBe(30);
    expect(d18.totalMinutes).toBe(90);
    expect(report.days[1].label).toBe("Di 19.05.");
  });

  it("splits an over-24h category total into blocks", () => {
    const report = buildCategoryReport(
      [
        entry({
          startedAt: iso(2026, 5, 18, 0, 0),
          endedAt: new Date(new Date(iso(2026, 5, 18, 0, 0)).getTime() + 1500 * 60_000).toISOString(),
          isAllgemeines: true,
          category: "QA",
        }),
      ],
      settings(),
      range,
    );
    const qa = report.categories.find((c) => c.name === "QA");
    expect(qa?.totalMinutes).toBe(1500);
    expect(qa?.blocks).toEqual([1440, 60]);
  });

  it("falls back to an em dash when no display name is set", () => {
    expect(
      buildCategoryReport([], settings({ jiraUser: null }), range).displayName,
    ).toBe("—");
  });
});
