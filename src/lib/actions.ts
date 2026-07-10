"use server";

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import {
  ALLGEMEINES_CATEGORIES,
  settings,
  timeEntries,
  type AllgemeinesCategory,
} from "@/db/schema";
import { getAllEntries, getRunningEntry, getSettings } from "@/db/queries";
import {
  checkCredentials,
  postWorklogToJira,
  type JiraAuth,
} from "@/lib/jira/worklog";
import { deriveJiraAuth } from "@/lib/settings";
import { effectiveDurationSeconds, parseBreaks } from "@/lib/work-time";
import {
  isForceBookingEnabled,
  setForceBookingState,
} from "@/lib/force-booking";
import {
  planForAllOpen,
  planForDay,
  stripInternal,
  type DayBookingPlan,
  type InternalWorklog,
  type SkippedEntry,
} from "@/lib/booking-plan";

function nowIso(): string {
  return new Date().toISOString();
}

/** Default category used when an entry is flagged Allgemeines without an explicit one. */
const DEFAULT_CATEGORY: AllgemeinesCategory = "Projektorganisation";

/**
 * Resolves the category to persist for an entry. Concrete entries never carry a
 * category; Allgemeines entries fall back to the default when none is given.
 */
function resolveCategory(
  isAllgemeines: boolean,
  category: AllgemeinesCategory | null | undefined,
): AllgemeinesCategory | null {
  if (!isAllgemeines) return null;
  return category && ALLGEMEINES_CATEGORIES.includes(category)
    ? category
    : DEFAULT_CATEGORY;
}

function revalidateAll(): void {
  revalidatePath("/");
  revalidatePath("/auswertung");
  revalidatePath("/einstellungen");
}

// ───────────────────────────── Timer ──────────────────────────────

/** Entries shorter than this are discarded on stop instead of being saved. */
const MIN_TRACKED_SECONDS = 60;

/**
 * Closes the running timer (if any). When the effective duration is below
 * `MIN_TRACKED_SECONDS` the row is deleted instead of getting an `endedAt`,
 * matching Jira's "no worklog under one minute" constraint.
 *
 * Returns metadata so the UI can show a toast for discarded entries.
 */
function closeRunningTimer(): {
  hadRunning: boolean;
  discarded: boolean;
  secondsTracked: number;
} {
  const running = getRunningEntry();
  if (!running) return { hadRunning: false, discarded: false, secondsTracked: 0 };

  const s = getSettings();
  const seconds = effectiveDurationSeconds(
    running.startedAt,
    null,
    parseBreaks(s.breaks),
    s.autoPauseEnabled,
  );

  if (seconds < MIN_TRACKED_SECONDS) {
    db.delete(timeEntries).where(eq(timeEntries.id, running.id)).run();
    return { hadRunning: true, discarded: true, secondsTracked: seconds };
  }

  const ended = nowIso();
  db.update(timeEntries)
    .set({ endedAt: ended, updatedAt: ended })
    .where(eq(timeEntries.id, running.id))
    .run();
  return { hadRunning: true, discarded: false, secondsTracked: seconds };
}

export type StartTimerResult = {
  previousDiscarded: boolean;
  previousSecondsTracked: number;
};

/** Stops any running timer, then starts a new one with the given text. */
export async function startTimer(
  description: string,
  isAllgemeines = false,
  category: AllgemeinesCategory | null = null,
): Promise<StartTimerResult> {
  const previous = closeRunningTimer();
  db.insert(timeEntries)
    .values({
      description: description ?? "",
      startedAt: nowIso(),
      isAllgemeines,
      category: resolveCategory(isAllgemeines, category),
    })
    .run();
  revalidateAll();
  return {
    previousDiscarded: previous.discarded,
    previousSecondsTracked: previous.secondsTracked,
  };
}

export type StopTimerResult = {
  stopped: boolean;
  discarded: boolean;
  secondsTracked: number;
};

/** Stops the running timer, if any. */
export async function stopTimer(): Promise<StopTimerResult> {
  const result = closeRunningTimer();
  revalidateAll();
  return {
    stopped: result.hadRunning,
    discarded: result.discarded,
    secondsTracked: result.secondsTracked,
  };
}

/** Updates the description of the currently running timer. */
export async function updateRunningDescription(
  description: string,
): Promise<void> {
  db.update(timeEntries)
    .set({ description: description ?? "", updatedAt: nowIso() })
    .where(isNull(timeEntries.endedAt))
    .run();
  revalidateAll();
}

/**
 * Toggles the Allgemeines flag on the currently running timer. Enabling it also
 * assigns the default category; disabling it clears the category.
 */
export async function updateRunningAllgemeines(
  isAllgemeines: boolean,
  category: AllgemeinesCategory | null = null,
): Promise<void> {
  db.update(timeEntries)
    .set({
      isAllgemeines,
      category: resolveCategory(isAllgemeines, category),
      updatedAt: nowIso(),
    })
    .where(isNull(timeEntries.endedAt))
    .run();
  revalidateAll();
}

/** Updates the report category of the currently running (Allgemeines) timer. */
export async function updateRunningCategory(
  category: AllgemeinesCategory,
): Promise<void> {
  db.update(timeEntries)
    .set({
      category: resolveCategory(true, category),
      updatedAt: nowIso(),
    })
    .where(isNull(timeEntries.endedAt))
    .run();
  revalidateAll();
}

/**
 * Updates the start time of the currently running timer. Used when the user
 * realises they pressed start too late and wants to back-date the timer live.
 */
export async function updateRunningStartedAt(
  startedAtIso: string,
): Promise<ActionResult> {
  const running = getRunningEntry();
  if (!running) {
    return { ok: false, message: "Kein laufender Timer." };
  }
  const start = new Date(startedAtIso);
  if (isNaN(start.getTime())) {
    return { ok: false, message: "Ungültiges Datum." };
  }
  const now = new Date();
  if (start.getTime() >= now.getTime()) {
    return { ok: false, message: "Start muss in der Vergangenheit liegen." };
  }
  const iso = start.toISOString();
  db.update(timeEntries)
    .set({ startedAt: iso, updatedAt: nowIso() })
    .where(eq(timeEntries.id, running.id))
    .run();
  revalidateAll();
  return { ok: true };
}

// ──────────────────────────── Entries ─────────────────────────────

const manualEntrySchema = z.object({
  description: z.string(),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  isAllgemeines: z.boolean().optional(),
  category: z.enum(ALLGEMEINES_CATEGORIES).nullable().optional(),
});

export type ActionResult = { ok: boolean; message?: string };

/** Creates a finished entry manually (without using the timer). */
export async function createManualEntry(input: {
  description: string;
  startedAt: string;
  endedAt: string;
  isAllgemeines?: boolean;
  category?: AllgemeinesCategory | null;
}): Promise<ActionResult> {
  const parsed = manualEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Ungültige Eingabe." };

  const start = new Date(parsed.data.startedAt);
  const end = new Date(parsed.data.endedAt);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { ok: false, message: "Ungültiges Datum." };
  }
  if (end <= start) {
    return { ok: false, message: "Ende muss nach dem Beginn liegen." };
  }

  const isAllgemeines = parsed.data.isAllgemeines ?? false;
  db.insert(timeEntries)
    .values({
      description: parsed.data.description,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      isAllgemeines,
      category: resolveCategory(isAllgemeines, parsed.data.category),
    })
    .run();
  revalidateAll();
  return { ok: true };
}

/** Edits an existing entry. Times are optional (description-only edit allowed). */
export async function updateEntry(
  id: number,
  input: {
    description: string;
    startedAt?: string;
    endedAt?: string;
    isAllgemeines?: boolean;
    category?: AllgemeinesCategory | null;
  },
): Promise<ActionResult> {
  const patch: Record<string, string | boolean | null> = {
    description: input.description ?? "",
    updatedAt: nowIso(),
  };

  if (input.startedAt && input.endedAt) {
    const start = new Date(input.startedAt);
    const end = new Date(input.endedAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { ok: false, message: "Ungültiges Datum." };
    }
    if (end <= start) {
      return { ok: false, message: "Ende muss nach dem Beginn liegen." };
    }
    patch.startedAt = start.toISOString();
    patch.endedAt = end.toISOString();
  }

  if (typeof input.isAllgemeines === "boolean") {
    patch.isAllgemeines = input.isAllgemeines;
    patch.category = resolveCategory(input.isAllgemeines, input.category);
  } else if (input.category !== undefined) {
    patch.category = input.category;
  }

  db.update(timeEntries).set(patch).where(eq(timeEntries.id, id)).run();
  revalidateAll();
  return { ok: true };
}

export async function deleteEntry(id: number): Promise<void> {
  db.delete(timeEntries).where(eq(timeEntries.id, id)).run();
  revalidateAll();
}

// ──────────────────────────── Settings ────────────────────────────

const breakSchema = z.object({
  start: z.string().regex(/^\d{1,2}:\d{2}$/),
  end: z.string().regex(/^\d{1,2}:\d{2}$/),
});

const settingsSchema = z.object({
  regularWorkMinutes: z.number().int().min(0).max(1440),
  dailyTargetMinutes: z.number().int().min(0).max(1440),
  breaks: z.array(breakSchema),
  autoPauseEnabled: z.boolean(),
  bookingMode: z.enum(["grouped", "individual"]),
  dataRetentionDays: z.number().int().min(1).max(3650),
  jiraUrl: z.string(),
  jiraProjectKeys: z.array(z.string()),
  jiraAuthMode: z.enum(["token", "basic"]),
  jiraToken: z.string().nullable(),
  jiraUser: z.string().nullable(),
  jiraPassword: z.string().nullable(),
  overtimeBaselineMinutes: z.number().int(),
  themeMode: z.enum(["system", "light", "dark"]),
  sprintAnchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sprintLengthDays: z.number().int().min(1).max(365),
  concreteIssueTargetPercent: z.number().int().min(0).max(100),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

export async function updateSettings(
  input: SettingsInput,
): Promise<ActionResult> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Ungültige Einstellungen." };
  }
  const d = parsed.data;
  getSettings(); // ensure row exists

  db.update(settings)
    .set({
      regularWorkMinutes: d.regularWorkMinutes,
      dailyTargetMinutes: d.dailyTargetMinutes,
      breaks: JSON.stringify(d.breaks),
      autoPauseEnabled: d.autoPauseEnabled,
      bookingMode: d.bookingMode,
      dataRetentionDays: d.dataRetentionDays,
      jiraUrl: d.jiraUrl.trim(),
      jiraProjectKeys: JSON.stringify(
        d.jiraProjectKeys.map((k) => k.trim().toUpperCase()).filter(Boolean),
      ),
      jiraAuthMode: d.jiraAuthMode,
      jiraToken: d.jiraToken,
      jiraUser: d.jiraUser,
      jiraPassword: d.jiraPassword,
      overtimeBaselineMinutes: d.overtimeBaselineMinutes,
      themeMode: d.themeMode,
      sprintAnchorDate: d.sprintAnchorDate,
      sprintLengthDays: d.sprintLengthDays,
      concreteIssueTargetPercent: d.concreteIssueTargetPercent,
      updatedAt: nowIso(),
    })
    .where(eq(settings.id, 1))
    .run();
  revalidateAll();
  return { ok: true };
}

/** Tests Jira credentials without persisting them. */
export async function testJiraConnection(input: {
  jiraUrl: string;
  jiraToken: string | null;
  jiraUser: string | null;
  jiraPassword?: string | null;
}): Promise<ActionResult> {
  if (!input.jiraUrl.trim()) {
    return { ok: false, message: "Bitte zuerst eine Jira-URL angeben." };
  }
  const user = input.jiraUser?.trim();
  const password =
    input.jiraToken?.trim() || input.jiraPassword?.trim() || null;
  if (!user || !password) {
    return {
      ok: false,
      message: "Bitte Atlassian-E-Mail und API-Token angeben.",
    };
  }
  if (!user.includes("@")) {
    return {
      ok: false,
      message: "Bitte die Atlassian-Konto-E-Mail-Adresse angeben.",
    };
  }

  const auth: JiraAuth = { user, password };
  const result = await checkCredentials(input.jiraUrl.trim(), auth);
  return result.ok
    ? { ok: true, message: `Verbunden als ${result.displayName}.` }
    : { ok: false, message: result.reason };
}

// ──────────────────────────── Cleanup ─────────────────────────────

export async function cleanupOldEntries(
  days: number,
): Promise<{ ok: boolean; deleted: number; message?: string }> {
  if (!Number.isFinite(days) || days < 1) {
    return { ok: false, deleted: 0, message: "Ungültige Tagesangabe." };
  }
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  // Only delete finished entries older than the cutoff — never a running timer.
  const stale = db
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(and(lt(timeEntries.startedAt, cutoff), isNotNull(timeEntries.endedAt)))
    .all();

  for (const row of stale) {
    db.delete(timeEntries).where(eq(timeEntries.id, row.id)).run();
  }
  revalidateAll();
  return { ok: true, deleted: stale.length };
}

// ────────────────────────── Jira booking ──────────────────────────

// Planning lives in `@/lib/booking-plan` (pure, DB-free). These wrappers just
// feed it the current entries, settings, and force-booking state.
function buildDayPlan(dayKeyStr: string) {
  return planForDay(
    getAllEntries(),
    getSettings(),
    isForceBookingEnabled(),
    dayKeyStr,
  );
}

function buildAllOpenPlan() {
  return planForAllOpen(getAllEntries(), getSettings(), isForceBookingEnabled());
}

/** Returns what would be booked for a day, without sending anything. */
export async function previewDayBooking(
  dayKeyStr: string,
): Promise<DayBookingPlan> {
  const { worklogs, skipped } = buildDayPlan(dayKeyStr);
  return { worklogs: stripInternal(worklogs), skipped };
}

/** Same as previewDayBooking, but across all days with open entries. */
export async function previewAllOpenBooking(): Promise<DayBookingPlan> {
  const { worklogs, skipped } = buildAllOpenPlan();
  return { worklogs: stripInternal(worklogs), skipped };
}

export type SubmitResult = {
  ok: boolean;
  bookedWorklogs: number;
  bookedEntries: number;
  errors: string[];
  skipped: SkippedEntry[];
  message?: string;
};

async function postPlanToJira(
  worklogs: InternalWorklog[],
  skipped: SkippedEntry[],
): Promise<SubmitResult> {
  const s = getSettings();
  const auth = deriveJiraAuth(s);
  if (!s.jiraUrl || !auth) {
    return {
      ok: false,
      bookedWorklogs: 0,
      bookedEntries: 0,
      errors: [],
      skipped,
      message: "Jira ist nicht vollständig konfiguriert (siehe Einstellungen).",
    };
  }

  if (worklogs.length === 0) {
    return {
      ok: true,
      bookedWorklogs: 0,
      bookedEntries: 0,
      errors: [],
      skipped,
      message: "Keine buchbaren Einträge gefunden.",
    };
  }

  const errors: string[] = [];
  let bookedWorklogs = 0;
  let bookedEntries = 0;

  // Bind the narrowed auth so it stays non-null inside the closure below.
  const jiraAuth: JiraAuth = auth;

  async function bookWorklog(wl: InternalWorklog): Promise<boolean> {
    try {
      await postWorklogToJira({
        jiraUrl: s.jiraUrl,
        auth: jiraAuth,
        issueKey: wl.issueKey,
        timeSpent: wl.timeSpent,
        started: wl.started,
        comment: wl.comment || undefined,
      });
      const submittedAt = nowIso();
      for (const id of wl.entryIds) {
        db.update(timeEntries)
          .set({
            submittedAt,
            jiraIssueKey: wl.issueKey,
            updatedAt: submittedAt,
          })
          .where(eq(timeEntries.id, id))
          .run();
      }
      bookedWorklogs += 1;
      bookedEntries += wl.entryIds.length;
      return true;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  for (const wl of worklogs) {
    await bookWorklog(wl);
  }

  revalidateAll();
  return {
    ok: errors.length === 0,
    bookedWorklogs,
    bookedEntries,
    errors,
    skipped,
  };
}

/** Books all not-yet-submitted entries of a day to Jira. */
export async function submitDayToJira(
  dayKeyStr: string,
): Promise<SubmitResult> {
  const { worklogs, skipped } = buildDayPlan(dayKeyStr);
  return postPlanToJira(worklogs, skipped);
}

/** Books all not-yet-submitted entries across every day. */
export async function submitAllOpenToJira(): Promise<SubmitResult> {
  const { worklogs, skipped } = buildAllOpenPlan();
  return postPlanToJira(worklogs, skipped);
}

// ───────────────────────── Force booking ──────────────────────────

/** Reads the runtime-only force-booking switch (not persisted). */
export async function getForceBooking(): Promise<boolean> {
  return isForceBookingEnabled();
}

/**
 * Toggles the runtime-only force-booking switch. Enabling it makes the booking
 * flow re-submit already-booked entries. Resets to off on app restart.
 */
export async function setForceBooking(enabled: boolean): Promise<void> {
  setForceBookingState(enabled);
  revalidateAll();
}
