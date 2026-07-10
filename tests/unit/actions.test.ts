import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type { NewTimeEntry, SettingsRow } from "@/db/schema";
import type { SettingsInput } from "@/lib/actions";

// Run the real DB layer against an isolated in-memory SQLite instance, and mock
// the framework/network edges so the actual server actions can be exercised.
process.env.JWL_DB_PATH = ":memory:";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/jira/worklog", () => ({
  postWorklogToJira: vi.fn(),
  checkCredentials: vi.fn(),
}));

type ActionsModule = typeof import("@/lib/actions");
type DbModule = typeof import("@/db");
type SchemaModule = typeof import("@/db/schema");
type WorklogModule = typeof import("@/lib/jira/worklog");

let actions: ActionsModule;
let db: DbModule["db"];
let schema: SchemaModule;
let jira: WorklogModule;

beforeAll(async () => {
  schema = await import("@/db/schema");
  ({ db } = await import("@/db")); // opens :memory: and migrates
  jira = await import("@/lib/jira/worklog");
  actions = await import("@/lib/actions");
});

const iso = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0).toISOString();
const agoMs = (ms: number) => new Date(Date.now() - ms).toISOString();

function setSettings(patch: Partial<SettingsRow> = {}): void {
  const existing = db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get();
  if (!existing) db.insert(schema.settings).values({ id: 1 }).run();
  if (Object.keys(patch).length) {
    db.update(schema.settings).set(patch).where(eq(schema.settings.id, 1)).run();
  }
}

function configureJira(): void {
  setSettings({
    jiraUrl: "https://x.atlassian.net",
    jiraUser: "u@example.com",
    jiraToken: "tok",
    jiraProjectKeys: JSON.stringify(["TXR"]),
    bookingMode: "grouped",
    autoPauseEnabled: false,
    breaks: "[]",
  });
}

function addEntry(v: NewTimeEntry): number {
  const res = db.insert(schema.timeEntries).values(v).run();
  return Number(res.lastInsertRowid);
}
const allEntries = () =>
  db.select().from(schema.timeEntries).orderBy(schema.timeEntries.id).all();
const runningEntry = () =>
  db.select().from(schema.timeEntries).where(isNull(schema.timeEntries.endedAt)).get();
const settingsRow = () =>
  db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get()!;

beforeEach(async () => {
  db.delete(schema.timeEntries).run();
  db.delete(schema.settings).run();
  setSettings(); // recreate the id=1 row with schema defaults
  await actions.setForceBooking(false);
  vi.mocked(jira.postWorklogToJira).mockReset();
  vi.mocked(jira.checkCredentials).mockReset();
});

describe("timer", () => {
  it("startTimer inserts a running entry", async () => {
    await actions.startTimer("TXR-1 work");
    const running = runningEntry()!;
    expect(running.description).toBe("TXR-1 work");
    expect(running.endedAt).toBeNull();
    expect(running.isAllgemeines).toBe(false);
    expect(running.category).toBeNull();
  });

  it("startTimer defaults the Allgemeines category, and ignores it for concrete entries", async () => {
    await actions.startTimer("a", true);
    expect(runningEntry()!.category).toBe("Projektorganisation");

    db.delete(schema.timeEntries).run();
    await actions.startTimer("b", true, "QA");
    expect(runningEntry()!.category).toBe("QA");

    db.delete(schema.timeEntries).run();
    await actions.startTimer("c", false, "QA");
    expect(runningEntry()!.category).toBeNull();
  });

  it("startTimer discards a too-short previous timer, keeps a long one", async () => {
    addEntry({ description: "short", startedAt: agoMs(20_000) });
    const discarded = await actions.startTimer("next");
    expect(discarded.previousDiscarded).toBe(true);
    expect(allEntries()).toHaveLength(1); // old row deleted

    db.delete(schema.timeEntries).run();
    addEntry({ description: "long", startedAt: agoMs(3_600_000) });
    const kept = await actions.startTimer("next");
    expect(kept.previousDiscarded).toBe(false);
    expect(allEntries().find((r) => r.description === "long")!.endedAt).not.toBeNull();
  });

  it("stopTimer reports no-op, discard, and normal stop", async () => {
    expect((await actions.stopTimer()).stopped).toBe(false);

    addEntry({ description: "tiny", startedAt: agoMs(20_000) });
    const short = await actions.stopTimer();
    expect(short).toMatchObject({ stopped: true, discarded: true });
    expect(allEntries()).toHaveLength(0);

    addEntry({ description: "real", startedAt: agoMs(3_600_000) });
    const ok = await actions.stopTimer();
    expect(ok).toMatchObject({ stopped: true, discarded: false });
    expect(runningEntry()).toBeUndefined();
  });

  it("updateRunningStartedAt validates the new start", async () => {
    expect(await actions.updateRunningStartedAt(iso(2026, 7, 1, 9, 0))).toEqual({
      ok: false,
      message: "Kein laufender Timer.",
    });

    addEntry({ description: "r", startedAt: agoMs(3_600_000) });
    expect((await actions.updateRunningStartedAt("nonsense")).message).toBe("Ungültiges Datum.");
    expect((await actions.updateRunningStartedAt(iso(2030, 1, 1, 0, 0))).message).toBe(
      "Start muss in der Vergangenheit liegen.",
    );
    expect(await actions.updateRunningStartedAt(iso(2026, 7, 1, 9, 0))).toEqual({ ok: true });
    expect(runningEntry()!.startedAt).toBe(new Date(iso(2026, 7, 1, 9, 0)).toISOString());
  });
});

describe("entries", () => {
  it("createManualEntry validates and inserts", async () => {
    expect((await actions.createManualEntry({ description: "x", startedAt: "", endedAt: iso(2026, 5, 18, 10, 0) })).message).toBe(
      "Ungültige Eingabe.",
    );
    expect(
      (await actions.createManualEntry({ description: "x", startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 10, 0) })).message,
    ).toBe("Ende muss nach dem Beginn liegen.");

    const ok = await actions.createManualEntry({ description: "manual", startedAt: iso(2026, 5, 18, 9, 0), endedAt: iso(2026, 5, 18, 10, 0) });
    expect(ok.ok).toBe(true);
    expect(allEntries()).toHaveLength(1);
    expect(allEntries()[0].endedAt).not.toBeNull();
  });

  it("updateEntry edits description and rejects an inverted range; deleteEntry removes", async () => {
    const id = addEntry({ description: "orig", startedAt: iso(2026, 5, 18, 9, 0), endedAt: iso(2026, 5, 18, 10, 0) });

    expect((await actions.updateEntry(id, { description: "edited" })).ok).toBe(true);
    expect(allEntries()[0].description).toBe("edited");

    expect(
      (await actions.updateEntry(id, { description: "e", startedAt: iso(2026, 5, 18, 11, 0), endedAt: iso(2026, 5, 18, 10, 0) })).message,
    ).toBe("Ende muss nach dem Beginn liegen.");

    await actions.deleteEntry(id);
    expect(allEntries()).toHaveLength(0);
  });

  it("cleanupOldEntries deletes only finished entries past the cutoff", async () => {
    expect(await actions.cleanupOldEntries(0)).toMatchObject({ ok: false, deleted: 0 });

    addEntry({ description: "old", startedAt: agoMs(40 * 86_400_000), endedAt: agoMs(40 * 86_400_000) });
    addEntry({ description: "recent", startedAt: agoMs(5 * 86_400_000), endedAt: agoMs(5 * 86_400_000) });
    addEntry({ description: "old-running", startedAt: agoMs(40 * 86_400_000) });

    expect(await actions.cleanupOldEntries(30)).toMatchObject({ ok: true, deleted: 1 });
    expect(allEntries().map((r) => r.description).sort()).toEqual(["old-running", "recent"]);
  });
});

describe("settings & connection", () => {
  it("updateSettings rejects invalid input and persists valid input (trim/uppercase)", async () => {
    const base: SettingsInput = {
      regularWorkMinutes: 420,
      dailyTargetMinutes: 420,
      breaks: [],
      autoPauseEnabled: true,
      bookingMode: "grouped",
      dataRetentionDays: 90,
      jiraUrl: "  https://x.atlassian.net  ",
      jiraProjectKeys: ["txr", " demo "],
      jiraAuthMode: "basic",
      jiraToken: "t",
      jiraUser: "u@example.com",
      jiraPassword: null,
      overtimeBaselineMinutes: 0,
      themeMode: "system",
      sprintAnchorDate: "2026-01-07",
      sprintLengthDays: 14,
      concreteIssueTargetPercent: 60,
    };

    expect((await actions.updateSettings({ ...base, regularWorkMinutes: 5000 })).message).toBe(
      "Ungültige Einstellungen.",
    );

    expect((await actions.updateSettings(base)).ok).toBe(true);
    const row = settingsRow();
    expect(row.jiraUrl).toBe("https://x.atlassian.net");
    expect(JSON.parse(row.jiraProjectKeys)).toEqual(["TXR", "DEMO"]);
  });

  it("testJiraConnection validates inputs and surfaces the credential check", async () => {
    expect((await actions.testJiraConnection({ jiraUrl: "", jiraToken: "t", jiraUser: "u@e.com" })).message).toBe(
      "Bitte zuerst eine Jira-URL angeben.",
    );
    expect(
      (await actions.testJiraConnection({ jiraUrl: "https://x", jiraToken: "t", jiraUser: "noat" })).message,
    ).toBe("Bitte die Atlassian-Konto-E-Mail-Adresse angeben.");

    vi.mocked(jira.checkCredentials).mockResolvedValue({ ok: true, displayName: "Ada" });
    expect(await actions.testJiraConnection({ jiraUrl: "https://x", jiraToken: "t", jiraUser: "u@e.com" })).toEqual({
      ok: true,
      message: "Verbunden als Ada.",
    });
    expect(jira.checkCredentials).toHaveBeenCalledWith("https://x", { user: "u@e.com", password: "t" });

    vi.mocked(jira.checkCredentials).mockResolvedValue({ ok: false, reason: "nope" });
    expect(await actions.testJiraConnection({ jiraUrl: "https://x", jiraToken: "t", jiraUser: "u@e.com" })).toEqual({
      ok: false,
      message: "nope",
    });
  });
});

describe("Jira booking", () => {
  const DAY = "2026-05-18";
  const bookable = () => ({ description: "TXR-1 x", startedAt: iso(2026, 5, 18, 10, 0), endedAt: iso(2026, 5, 18, 10, 30) });

  it("refuses to submit when Jira is not configured", async () => {
    addEntry(bookable()); // default settings have no jiraUrl
    const res = await actions.submitDayToJira(DAY);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("nicht vollständig konfiguriert");
    expect(jira.postWorklogToJira).not.toHaveBeenCalled();
  });

  it("reports nothing to book when there are no eligible entries", async () => {
    configureJira();
    const res = await actions.submitDayToJira(DAY);
    expect(res).toMatchObject({ ok: true, bookedWorklogs: 0, message: "Keine buchbaren Einträge gefunden." });
  });

  it("books a worklog and marks the entries submitted", async () => {
    configureJira();
    const id = addEntry(bookable());
    vi.mocked(jira.postWorklogToJira).mockResolvedValue(undefined);

    const res = await actions.submitDayToJira(DAY);
    expect(res).toMatchObject({ ok: true, bookedWorklogs: 1, bookedEntries: 1, errors: [] });
    expect(jira.postWorklogToJira).toHaveBeenCalledWith(
      expect.objectContaining({ issueKey: "TXR-1", timeSpent: "30m", comment: "x", jiraUrl: "https://x.atlassian.net" }),
    );
    const row = allEntries().find((r) => r.id === id)!;
    expect(row.submittedAt).not.toBeNull();
    expect(row.jiraIssueKey).toBe("TXR-1");
  });

  it("collects errors and leaves entries unsubmitted when Jira rejects", async () => {
    configureJira();
    const id = addEntry(bookable());
    vi.mocked(jira.postWorklogToJira).mockRejectedValue(new Error("boom"));

    const res = await actions.submitDayToJira(DAY);
    expect(res).toMatchObject({ ok: false, bookedWorklogs: 0, errors: ["boom"] });
    expect(allEntries().find((r) => r.id === id)!.submittedAt).toBeNull();
  });

  it("force booking re-includes already-submitted entries in the preview", async () => {
    configureJira();
    addEntry({ ...bookable(), submittedAt: iso(2026, 5, 18, 18, 0) });

    expect((await actions.previewDayBooking(DAY)).worklogs).toHaveLength(0);
    await actions.setForceBooking(true);
    expect((await actions.previewDayBooking(DAY)).worklogs).toHaveLength(1);
  });
});
