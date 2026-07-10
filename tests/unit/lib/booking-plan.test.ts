import { describe, expect, it } from "vitest";
import type { SettingsRow, TimeEntry } from "@/db/schema";
import {
  buildPlanInternal,
  planForAllOpen,
  planForDay,
  selectBookableEntries,
  stripInternal,
} from "@/lib/booking-plan";

const iso = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString();

let idSeq = 1;
function entry(o: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: o.id ?? idSeq++,
    description: "",
    startedAt: iso(2026, 5, 18, 10, 0),
    endedAt: iso(2026, 5, 18, 10, 30),
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
    jiraProjectKeys: JSON.stringify(["TXR", "DEMO"]),
    breaks: "[]",
    autoPauseEnabled: false,
    bookingMode: "grouped",
    ...o,
  } as unknown as SettingsRow;
}

describe("selectBookableEntries", () => {
  const entries = [
    entry({ id: 1 }), // bookable
    entry({ id: 2, endedAt: null }), // running
    entry({ id: 3, isAllgemeines: true }), // report-only
    entry({ id: 4, submittedAt: iso(2026, 5, 18, 18, 0) }), // already booked
  ];

  it("keeps only finished, concrete, unsubmitted entries", () => {
    expect(selectBookableEntries(entries, false).map((e) => e.id)).toEqual([1]);
  });

  it("includes already-submitted entries when force is set", () => {
    expect(selectBookableEntries(entries, true).map((e) => e.id)).toEqual([1, 4]);
  });

  it("filters by local day when a day key is given", () => {
    const twoDays = [
      entry({ id: 10, startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
      entry({ id: 11, startedAt: iso(2026, 5, 19, 10, 0), endedAt: iso(2026, 5, 19, 10, 30) }),
    ];
    expect(selectBookableEntries(twoDays, false, "2026-05-18").map((e) => e.id)).toEqual([10]);
  });
});

describe("buildPlanInternal — grouped", () => {
  it("merges entries per issue: summed minutes, deduped comments, earliest start", () => {
    const plan = buildPlanInternal(
      [
        entry({ id: 1, description: "TXR-1 a", startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 11, 20) }),
        entry({ id: 2, description: "TXR-1 b", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
      ],
      settings({ bookingMode: "grouped" }),
    );
    expect(plan.worklogs).toHaveLength(1);
    const wl = plan.worklogs[0];
    expect(wl.issueKey).toBe("TXR-1");
    expect(wl.minutes).toBe(50);
    expect(wl.timeSpent).toBe("50m");
    expect(wl.entryCount).toBe(2);
    expect(wl.comment).toBe("a, b");
    expect(wl.started).toEqual(new Date(iso(2026, 5, 18, 10, 0))); // earliest
    expect([...wl.entryIds].sort()).toEqual([1, 2]);
  });

  it("dedupes identical comments", () => {
    const plan = buildPlanInternal(
      [
        entry({ id: 1, description: "TXR-1 same", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ id: 2, description: "TXR-1 same", startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 11, 30) }),
        entry({ id: 3, description: "TXR-1 other", startedAt: iso(2026, 5, 18, 12, 0), endedAt: iso(2026, 5, 18, 12, 30) }),
      ],
      settings(),
    );
    expect(plan.worklogs[0].comment).toBe("same, other");
  });
});

describe("buildPlanInternal — individual & skips", () => {
  it("emits one worklog per entry in individual mode", () => {
    const plan = buildPlanInternal(
      [
        entry({ id: 1, description: "TXR-1 a", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ id: 2, description: "TXR-1 b", startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 11, 20) }),
      ],
      settings({ bookingMode: "individual" }),
    );
    expect(plan.worklogs.map((w) => [w.issueKey, w.minutes])).toEqual([
      ["TXR-1", 30],
      ["TXR-1", 20],
    ]);
  });

  it("skips entries with no issue key or under a minute", () => {
    const plan = buildPlanInternal(
      [
        entry({ id: 1, description: "no key here", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ id: 2, description: "TXR-1 tiny", startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 11, 0, 20) }),
      ],
      settings(),
    );
    expect(plan.worklogs).toHaveLength(0);
    expect(plan.skipped).toEqual([
      { description: "no key here", reason: "Kein Issue-Key erkannt" },
      { description: "TXR-1 tiny", reason: "Dauer unter 1 Minute" },
    ]);
  });

  it("never books an Allgemeines entry even if passed directly", () => {
    const plan = buildPlanInternal(
      [entry({ id: 1, description: "TXR-1 a", isAllgemeines: true })],
      settings(),
    );
    expect(plan.worklogs).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });
});

describe("planForDay / planForAllOpen / stripInternal", () => {
  it("planForDay restricts to the requested day", () => {
    const plan = planForDay(
      [
        entry({ id: 1, description: "TXR-1 a", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ id: 2, description: "TXR-2 b", startedAt: iso(2026, 5, 19, 10, 0), endedAt: iso(2026, 5, 19, 10, 30) }),
      ],
      settings(),
      false,
      "2026-05-18",
    );
    expect(plan.worklogs.map((w) => w.issueKey)).toEqual(["TXR-1"]);
  });

  it("planForAllOpen groups per day, so one issue across two days yields two worklogs", () => {
    const plan = planForAllOpen(
      [
        entry({ id: 1, description: "TXR-1 a", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) }),
        entry({ id: 2, description: "TXR-1 b", startedAt: iso(2026, 5, 19, 10, 0), endedAt: iso(2026, 5, 19, 10, 30) }),
      ],
      settings({ bookingMode: "grouped" }),
      false,
    );
    expect(plan.worklogs).toHaveLength(2);
  });

  it("stripInternal removes the started/entryIds fields", () => {
    const { worklogs } = planForDay(
      [entry({ id: 1, description: "TXR-1 a", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) })],
      settings(),
      false,
      "2026-05-18",
    );
    const stripped = stripInternal(worklogs)[0];
    expect(stripped).not.toHaveProperty("started");
    expect(stripped).not.toHaveProperty("entryIds");
    expect(stripped).toMatchObject({ issueKey: "TXR-1", minutes: 30, entryCount: 1 });
  });
});
