// Pure Jira-booking planning: turns finished time entries into the worklogs
// Jira should receive. No DB, network, or Next.js dependencies — the server
// actions in `@/lib/actions` read the entries/settings and delegate here.

import type { SettingsRow, TimeEntry } from "@/db/schema";
import { dayKey, formatDurationHoursMinutes } from "@/lib/format";
import { parseDescription } from "@/lib/parse-description";
import { parseProjectKeys } from "@/lib/settings";
import { effectiveDurationSeconds, parseBreaks } from "@/lib/work-time";

export type PlannedWorklog = {
  issueKey: string;
  timeSpent: string;
  minutes: number;
  comment: string;
  entryCount: number;
};

export type SkippedEntry = { description: string; reason: string };

export type DayBookingPlan = {
  worklogs: PlannedWorklog[];
  skipped: SkippedEntry[];
};

export type InternalWorklog = PlannedWorklog & {
  started: Date;
  entryIds: number[];
};

export type InternalPlan = {
  worklogs: InternalWorklog[];
  skipped: SkippedEntry[];
};

type Parsed = {
  id: number;
  issueKey: string;
  comment: string;
  seconds: number;
  started: Date;
};

/**
 * Filters the entries that are eligible to be booked to Jira: finished, not
 * Allgemeines (those are report-only), and — unless `force` is set — not yet
 * submitted. When `dayKeyStr` is given, only entries on that local day are kept.
 */
export function selectBookableEntries(
  entries: TimeEntry[],
  force: boolean,
  dayKeyStr?: string,
): TimeEntry[] {
  return entries.filter(
    (e) =>
      e.endedAt !== null &&
      !e.isAllgemeines &&
      (force || e.submittedAt === null) &&
      (dayKeyStr === undefined || dayKey(e.startedAt) === dayKeyStr),
  );
}

/**
 * Turns a set of finished, unsubmitted entries (typically already filtered to
 * a single day) into the worklogs Jira should receive. Grouped/individual mode
 * is read from settings. Callers must never mix entries from different days
 * here — grouped mode would otherwise produce a single worklog spanning days.
 */
export function buildPlanInternal(
  candidates: TimeEntry[],
  s: SettingsRow,
): InternalPlan {
  const projectKeys = parseProjectKeys(s.jiraProjectKeys);
  const breaks = parseBreaks(s.breaks);
  const skipped: SkippedEntry[] = [];
  const valid: Parsed[] = [];

  for (const entry of candidates) {
    // Allgemeines entries are never booked to Jira — callers filter them out,
    // but guard here too so a stray one can never reach a worklog.
    if (entry.isAllgemeines) continue;

    const seconds = effectiveDurationSeconds(
      entry.startedAt,
      entry.endedAt,
      breaks,
      s.autoPauseEnabled,
    );

    const parsed = parseDescription(entry.description, projectKeys);
    if (!parsed.issueKey) {
      skipped.push({
        description: entry.description || "(ohne Beschreibung)",
        reason: "Kein Issue-Key erkannt",
      });
      continue;
    }
    const issueKey = parsed.issueKey;
    const comment = parsed.comment;

    if (Math.round(seconds / 60) < 1) {
      skipped.push({
        description: entry.description || "(ohne Beschreibung)",
        reason: "Dauer unter 1 Minute",
      });
      continue;
    }
    valid.push({
      id: entry.id,
      issueKey,
      comment,
      seconds,
      started: new Date(entry.startedAt),
    });
  }

  const worklogs: InternalWorklog[] = [];

  if (s.bookingMode === "grouped") {
    const byIssue = new Map<string, Parsed[]>();
    for (const p of valid) {
      const bucket = byIssue.get(p.issueKey);
      if (bucket) bucket.push(p);
      else byIssue.set(p.issueKey, [p]);
    }
    for (const [issueKey, group] of byIssue) {
      const minutes = Math.round(
        group.reduce((sum, p) => sum + p.seconds, 0) / 60,
      );
      const comments = [
        ...new Set(group.map((p) => p.comment).filter(Boolean)),
      ];
      const started = group.reduce(
        (min, p) => (p.started < min ? p.started : min),
        group[0].started,
      );
      worklogs.push({
        issueKey,
        minutes,
        timeSpent: formatDurationHoursMinutes(minutes),
        comment: comments.join(", "),
        entryCount: group.length,
        started,
        entryIds: group.map((p) => p.id),
      });
    }
  } else {
    for (const p of valid) {
      const minutes = Math.round(p.seconds / 60);
      worklogs.push({
        issueKey: p.issueKey,
        minutes,
        timeSpent: formatDurationHoursMinutes(minutes),
        comment: p.comment,
        entryCount: 1,
        started: p.started,
        entryIds: [p.id],
      });
    }
  }

  return { worklogs, skipped };
}

/** Plan for a single day. `entries` is the full set; filtering happens here. */
export function planForDay(
  entries: TimeEntry[],
  s: SettingsRow,
  force: boolean,
  dayKeyStr: string,
): InternalPlan {
  return buildPlanInternal(selectBookableEntries(entries, force, dayKeyStr), s);
}

/** Plan covering every day that still has bookable entries. */
export function planForAllOpen(
  entries: TimeEntry[],
  s: SettingsRow,
  force: boolean,
): InternalPlan {
  const candidates = selectBookableEntries(entries, force);

  const byDay = new Map<string, TimeEntry[]>();
  for (const entry of candidates) {
    const key = dayKey(entry.startedAt);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(entry);
    else byDay.set(key, [entry]);
  }

  const worklogs: InternalWorklog[] = [];
  const skipped: SkippedEntry[] = [];
  for (const dayEntries of byDay.values()) {
    const plan = buildPlanInternal(dayEntries, s);
    worklogs.push(...plan.worklogs);
    skipped.push(...plan.skipped);
  }
  return { worklogs, skipped };
}

/** Drops the internal booking fields, leaving the UI-facing shape. */
export function stripInternal(worklogs: InternalWorklog[]): PlannedWorklog[] {
  return worklogs.map(({ started: _s, entryIds: _i, ...rest }) => {
    void _s;
    void _i;
    return rest;
  });
}
