import { describe, expect, it } from "vitest";
import type { TimeEntry } from "@/db/schema";
import {
  buildDayGroups,
  concreteSecondsByDay,
  overtimeBalanceMinutes,
  toEntryView,
  workedSecondsByDay,
  type EntryAnalysisConfig,
} from "@/lib/entries";

/** Local-time ISO helper (dayKey/duration math is all local). */
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
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...o,
  } as TimeEntry;
}

const cfg: EntryAnalysisConfig = {
  projectKeys: ["TXR"],
  breaks: [],
  autoPauseEnabled: false,
};

describe("toEntryView", () => {
  it("maps a finished entry and parses the issue key + comment", () => {
    const v = toEntryView(
      entry({
        description: "TXR-1 fix",
        startedAt: iso(2026, 5, 18, 10, 0),
        endedAt: iso(2026, 5, 18, 10, 30),
      }),
      cfg,
    );
    expect(v.issueKey).toBe("TXR-1");
    expect(v.comment).toBe("fix");
    expect(v.effectiveSeconds).toBe(1800);
  });

  it("reports 0 effective seconds for a running entry", () => {
    expect(toEntryView(entry({ endedAt: null }), cfg).effectiveSeconds).toBe(0);
  });

  it("subtracts break overlap when auto-pause is on", () => {
    const v = toEntryView(
      entry({ startedAt: iso(2026, 5, 18, 12, 0), endedAt: iso(2026, 5, 18, 13, 0) }),
      { projectKeys: [], breaks: [{ start: "12:15", end: "12:45" }], autoPauseEnabled: true },
    );
    expect(v.effectiveSeconds).toBe(1800); // 3600 − 1800 break
  });
});

describe("buildDayGroups", () => {
  it("groups a day's entries by identical description", () => {
    const [day] = buildDayGroups(
      [
        entry({ description: "TXR-1 a", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ description: "TXR-1 a", startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 11, 20) }),
      ],
      cfg,
    );
    expect(day.dayKey).toBe("2026-05-18");
    expect(day.groups).toHaveLength(1);
    expect(day.groups[0].entries).toHaveLength(2);
    expect(day.groups[0].totalSeconds).toBe(1800 + 1200);
    expect(day.groups[0].allSubmitted).toBe(false);
    expect(day.totalSeconds).toBe(3000);
    expect(day.unsubmittedCount).toBe(2);
  });

  it("separates Allgemeines from concrete work and excludes it from unsubmittedCount", () => {
    const [day] = buildDayGroups(
      [
        entry({ description: "same", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({
          description: "same",
          startedAt: iso(2026, 5, 18, 12, 0),
          endedAt: iso(2026, 5, 18, 12, 30),
          isAllgemeines: true,
          category: "QA",
        }),
      ],
      cfg,
    );
    expect(day.groups).toHaveLength(2); // distinct despite identical text
    expect(day.unsubmittedCount).toBe(1); // Allgemeines is never "open"
  });

  it("marks a group allSubmitted when every entry is submitted", () => {
    const [day] = buildDayGroups(
      [
        entry({
          description: "TXR-1 a",
          startedAt: iso(2026, 5, 18, 10, 0),
          endedAt: iso(2026, 5, 18, 10, 30),
          submittedAt: iso(2026, 5, 18, 18, 0),
        }),
      ],
      cfg,
    );
    expect(day.groups[0].allSubmitted).toBe(true);
    expect(day.unsubmittedCount).toBe(0);
  });

  it("excludes running entries and sorts days newest-first", () => {
    const days = buildDayGroups(
      [
        entry({ description: "d1", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ description: "d2", startedAt: iso(2026, 5, 20, 10, 0), endedAt: iso(2026, 5, 20, 10, 30) }),
        entry({ description: "still running", startedAt: iso(2026, 5, 21, 10, 0), endedAt: null }),
      ],
      cfg,
    );
    expect(days.map((d) => d.dayKey)).toEqual(["2026-05-20", "2026-05-18"]);
  });
});

describe("overtimeBalanceMinutes", () => {
  it("subtracts the weekday target and counts weekend work as pure overtime", () => {
    const worked = new Map([
      ["2026-05-18", 480 * 60], // Monday, 8h → +60 over the 7h target
      ["2026-05-23", 120 * 60], // Saturday, 2h → +120 (no target)
    ]);
    expect(overtimeBalanceMinutes(worked, 420)).toBe(60 + 120);
  });

  it("adds the carried-in baseline and rounds", () => {
    const worked = new Map([["2026-05-18", 425 * 60]]); // Monday, +5
    expect(overtimeBalanceMinutes(worked, 420, 100)).toBe(105);
  });
});

describe("workedSecondsByDay / concreteSecondsByDay", () => {
  it("sums effective seconds per day for finished entries only", () => {
    const map = workedSecondsByDay(
      [
        entry({ startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 11, 20) }),
        entry({ startedAt: iso(2026, 5, 20, 9, 0), endedAt: iso(2026, 5, 20, 9, 15) }),
        entry({ startedAt: iso(2026, 5, 21, 9, 0), endedAt: null }), // running
      ],
      cfg,
    );
    expect(map.get("2026-05-18")).toBe(3000);
    expect(map.get("2026-05-20")).toBe(900);
    expect(map.has("2026-05-21")).toBe(false);
  });

  it("concreteSecondsByDay excludes Allgemeines entries", () => {
    const map = concreteSecondsByDay(
      [
        entry({ startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({
          startedAt: iso(2026, 5, 18, 12, 0),
          endedAt: iso(2026, 5, 18, 12, 20),
          isAllgemeines: true,
          category: "QA",
        }),
      ],
      cfg,
    );
    expect(map.get("2026-05-18")).toBe(1800); // only the concrete 30-min entry
  });
});
