"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Card, EmptyState, KpiCard, PageHeader } from "@/components/ui";
import {
  createManualEntry,
  deleteEntry,
  previewAllOpenBooking,
  previewDayBooking,
  startTimer,
  stopTimer,
  submitAllOpenToJira,
  submitDayToJira,
  updateEntry,
  updateRunningAllgemeines,
  updateRunningCategory,
  updateRunningDescription,
  updateRunningStartedAt,
  type SubmitResult,
} from "@/lib/actions";
import { type DayBookingPlan } from "@/lib/booking-plan";
import {
  ALLGEMEINES_CATEGORIES,
  type AllgemeinesCategory,
} from "@/db/schema";
import type { DayGroup, DescGroup, EntryView } from "@/lib/entries";
import { clockTime, formatHms, formatSignedHm } from "@/lib/format";
import { effectiveDurationSeconds, type BreakWindow } from "@/lib/work-time";

const DEFAULT_CATEGORY: AllgemeinesCategory = "Projektorganisation";

/** Small labelled dropdown for picking an Allgemeines report category. */
function CategorySelect({
  value,
  onChange,
  disabled,
}: {
  value: AllgemeinesCategory;
  onChange: (category: AllgemeinesCategory) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <span style={{ color: "var(--text-2)" }}>Kategorie</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as AllgemeinesCategory)}
        className="rounded-md border px-2 py-1 text-[13px] outline-none"
        style={{
          background: "var(--surface-2)",
          borderColor: "var(--border-strong)",
          color: "var(--text)",
        }}
      >
        {ALLGEMEINES_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

export type JiraScope =
  | { kind: "day"; dayKey: string; label: string }
  | { kind: "all" };

export type BuchenData = {
  running: {
    id: number;
    description: string;
    startedAt: string;
    isAllgemeines: boolean;
    category: AllgemeinesCategory | null;
  } | null;
  todayCommittedSeconds: number;
  overtimeBalanceMinutes: number;
  days: DayGroup[];
  config: {
    dailyTargetMinutes: number;
    autoPauseEnabled: boolean;
    breaks: BreakWindow[];
    bookingMode: "grouped" | "individual";
    jiraConfigured: boolean;
    forceBooking: boolean;
  };
};

/**
 * How many of a day's finished entries can be sent to Jira right now. In force
 * mode every finished entry is (re-)bookable; otherwise only unsubmitted ones.
 */
function bookableCount(day: DayGroup, forceBooking: boolean): number {
  if (!forceBooking) return day.unsubmittedCount;
  return day.groups.reduce((sum, g) => sum + g.entries.length, 0);
}

export function BuchenView({ data }: { data: BuchenData }) {
  const { running, todayCommittedSeconds, overtimeBalanceMinutes, days, config } =
    data;

  // ── Live ticking timer ─────────────────────────────────────────
  // Initialized to null so SSR and first client render agree, then set on mount.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const initial = setTimeout(() => setNow(new Date()), 0);
    if (!running) return () => clearTimeout(initial);
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [running]);

  const runningSeconds = useMemo(() => {
    if (!running || !now) return 0;
    return effectiveDurationSeconds(
      running.startedAt,
      null,
      config.breaks,
      config.autoPauseEnabled,
      now,
    );
  }, [running, config.breaks, config.autoPauseEnabled, now]);

  const runningIsToday = useMemo(() => {
    if (!running || !now) return false;
    const start = new Date(running.startedAt);
    return (
      start.getFullYear() === now.getFullYear() &&
      start.getMonth() === now.getMonth() &&
      start.getDate() === now.getDate()
    );
  }, [running, now]);

  const todayTotalSeconds =
    todayCommittedSeconds + (running && runningIsToday ? runningSeconds : 0);
  const targetSeconds = config.dailyTargetMinutes * 60;
  const remaining = targetSeconds - todayTotalSeconds;
  const reached = remaining <= 0;
  const progress = targetSeconds > 0 ? todayTotalSeconds / targetSeconds : 0;

  // ── Dialog & toast state ──────────────────────────────────────
  const [manualOpen, setManualOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<EntryView | null>(null);
  const [jiraScope, setJiraScope] = useState<JiraScope | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const totalBookable = days.reduce(
    (s, d) => s + bookableCount(d, config.forceBooking),
    0,
  );
  const hasAnyBookable = totalBookable > 0;

  return (
    <main className="px-8 py-7">
      <PageHeader
        title="Buchen"
        subtitle={now?.toLocaleDateString("de-DE", {
          weekday: "long",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })}
        actions={
          <>
            {hasAnyBookable && config.jiraConfigured && (
              <Button
                variant={config.forceBooking ? "danger" : "primary"}
                onClick={() => setJiraScope({ kind: "all" })}
              >
                Nach Jira buchen ({totalBookable})
              </Button>
            )}
            <Button onClick={() => setManualOpen(true)}>+ Eintrag</Button>
          </>
        }
      />

      {toast && (
        <div
          className="mb-4 rounded-lg border px-4 py-2.5 text-[13px]"
          style={{
            background: "var(--warn-soft)",
            borderColor: "var(--warn)",
            color: "var(--warn)",
          }}
          role="status"
        >
          {toast}
        </div>
      )}

      {config.forceBooking && (
        <div
          className="mb-4 rounded-lg border px-4 py-2.5 text-[13px] font-semibold"
          style={{
            background: "var(--neg-soft)",
            borderColor: "var(--neg)",
            color: "var(--neg)",
          }}
          role="alert"
        >
          ⚠️ Force-Buchung aktiv — bereits gebuchte Einträge werden beim Buchen
          erneut nach Jira übertragen. In den Einstellungen deaktivierbar.
        </div>
      )}

      <div className="grid grid-cols-4 gap-3.5 mb-5">
        <KpiCard
          label="Heute erfasst"
          value={formatHms(todayTotalSeconds)}
          progress={Math.max(0, Math.min(1, progress))}
        />
        <KpiCard
          label="Tagesziel"
          value={formatHms(targetSeconds)}
          tone="accent"
          meta="aus den Einstellungen"
        />
        <KpiCard
          label={reached ? "Über Ziel" : "Verbleibend bis Ziel"}
          value={formatHms(Math.abs(remaining))}
          tone={reached ? "pos" : "warn"}
          meta={reached ? "Ziel erreicht 🎉" : "bis das Tagesziel erreicht ist"}
        />
        <KpiCard
          label="Überstundensaldo"
          value={formatSignedHm(overtimeBalanceMinutes)}
          tone={overtimeBalanceMinutes >= 0 ? "pos" : "neg"}
          meta="über alle erfassten Tage"
        />
      </div>

      <TimerCard
        running={running}
        runningSeconds={runningSeconds}
        onToast={setToast}
      />

      <div className="mt-7">
        <div className="text-[15px] font-semibold mb-3">Einträge</div>
        {days.length === 0 ? (
          <Card>
            <EmptyState
              title="Noch keine Einträge"
              description="Starte oben den Timer oder lege einen Eintrag manuell an."
            />
          </Card>
        ) : (
          days.map((day) => (
            <DaySection
              key={day.dayKey}
              day={day}
              jiraConfigured={config.jiraConfigured}
              forceBooking={config.forceBooking}
              onPlay={async (text, allgemeines, category) => {
                const r = await startTimer(text, allgemeines, category);
                if (r.previousDiscarded) {
                  setToast(
                    "Vorheriger Eintrag verworfen (kürzer als 1 Minute).",
                  );
                }
              }}
              onEdit={(entry) => setEditEntry(entry)}
              onSubmitJira={() =>
                setJiraScope({
                  kind: "day",
                  dayKey: day.dayKey,
                  label: day.label,
                })
              }
            />
          ))
        )}
      </div>

      {manualOpen && (
        <ManualEntryDialog onClose={() => setManualOpen(false)} />
      )}
      {editEntry && (
        <EditEntryDialog entry={editEntry} onClose={() => setEditEntry(null)} />
      )}
      {jiraScope && (
        <JiraSubmitDialog
          scope={jiraScope}
          bookingMode={config.bookingMode}
          forceBooking={config.forceBooking}
          onClose={() => setJiraScope(null)}
        />
      )}
    </main>
  );
}

// ────────────────────────── Timer card ──────────────────────────

function TimerCard({
  running,
  runningSeconds,
  onToast,
}: {
  running: BuchenData["running"];
  runningSeconds: number;
  onToast: (msg: string) => void;
}) {
  const [draft, setDraft] = useState(running?.description ?? "");
  const [allgemeines, setAllgemeines] = useState(running?.isAllgemeines ?? false);
  const [category, setCategory] = useState<AllgemeinesCategory>(
    running?.category ?? DEFAULT_CATEGORY,
  );
  const [pending, setPending] = useState(false);
  const [editStart, setEditStart] = useState(false);
  const [startDraft, setStartDraft] = useState("");
  const lastSyncedRef = useRef(running?.id ?? null);

  // When the running entry changes (start/stop), reset the local draft.
  useEffect(() => {
    if (running?.id !== lastSyncedRef.current) {
      setDraft(running?.description ?? "");
      setAllgemeines(running?.isAllgemeines ?? false);
      setCategory(running?.category ?? DEFAULT_CATEGORY);
      setEditStart(false);
      lastSyncedRef.current = running?.id ?? null;
    }
  }, [
    running?.id,
    running?.description,
    running?.isAllgemeines,
    running?.category,
  ]);

  async function onStart() {
    if (pending) return;
    setPending(true);
    try {
      const r = await startTimer(
        draft,
        allgemeines,
        allgemeines ? category : null,
      );
      if (r.previousDiscarded) {
        onToast("Vorheriger Eintrag verworfen (kürzer als 1 Minute).");
      }
    } finally {
      setPending(false);
    }
  }

  async function onStop() {
    if (pending) return;
    setPending(true);
    try {
      const r = await stopTimer();
      if (r.discarded) {
        onToast(
          "Eintrag verworfen — Timer lief weniger als 1 Minute (zu kurz für Jira).",
        );
      }
    } finally {
      setPending(false);
    }
  }

  async function flushDescription() {
    if (running && draft !== running.description) {
      await updateRunningDescription(draft);
    }
  }

  async function toggleAllgemeines(next: boolean) {
    setAllgemeines(next);
    if (running) {
      await updateRunningAllgemeines(next, next ? category : null);
    }
  }

  async function changeCategory(next: AllgemeinesCategory) {
    setCategory(next);
    if (running && allgemeines) {
      await updateRunningCategory(next);
    }
  }

  function beginEditStart() {
    if (!running) return;
    setStartDraft(toLocalInputValue(running.startedAt));
    setEditStart(true);
  }

  async function commitStartEdit() {
    if (!running) {
      setEditStart(false);
      return;
    }
    const iso = fromLocalInputValue(startDraft);
    if (iso === running.startedAt) {
      setEditStart(false);
      return;
    }
    const res = await updateRunningStartedAt(iso);
    if (!res.ok) {
      onToast(res.message ?? "Startzeit konnte nicht geändert werden.");
    }
    setEditStart(false);
  }

  return (
    <Card>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={running ? onStop : onStart}
          disabled={pending}
          className="flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-60"
          style={{
            background: running ? "var(--neg)" : "var(--accent)",
          }}
          aria-label={running ? "Timer stoppen" : "Timer starten"}
        >
          {running ? (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-[20px] w-[20px]"
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-[20px] w-[20px]"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={flushDescription}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (running) flushDescription();
              else onStart();
            }
          }}
          placeholder={
            allgemeines
              ? "Worklogtext für Allgemeines"
              : "Woran arbeitest du?  ·  Format: Merksatz  TXR-1234  Worklogtext"
          }
          className="flex-1 rounded-lg border px-3.5 py-3 text-[15px] outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-strong)",
            color: "var(--text)",
          }}
        />

        <div
          className="num text-[28px] font-bold tabular-nums min-w-[150px] text-center"
          style={{ color: running ? "var(--accent)" : "var(--text-3)" }}
        >
          {formatHms(running ? runningSeconds : 0)}
        </div>
      </div>
      {running && (
        <div className="mt-3 flex items-center gap-2 text-[13px]">
          <span style={{ color: "var(--text-2)" }}>Gestartet</span>
          {editStart ? (
            <>
              <input
                type="datetime-local"
                value={startDraft}
                autoFocus
                onChange={(e) => setStartDraft(e.target.value)}
                onBlur={commitStartEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitStartEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditStart(false);
                  }
                }}
                className="rounded-md border px-2 py-1 text-[13px] outline-none"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--border-strong)",
                  color: "var(--text)",
                }}
              />
              <button
                type="button"
                onClick={() => setEditStart(false)}
                className="text-[12px]"
                style={{ color: "var(--text-3)" }}
              >
                Abbrechen
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={beginEditStart}
              className="rounded-md border px-2 py-0.5 text-[13px] font-semibold tabular-nums"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--border-strong)",
                color: "var(--text)",
              }}
              title="Startzeit anpassen"
            >
              {formatRunningStart(running.startedAt)}
            </button>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={allgemeines}
            onChange={(e) => toggleAllgemeines(e.target.checked)}
          />
          <span style={{ color: "var(--text-2)" }}>
            Als Allgemein speichern (nicht nach Jira buchen)
          </span>
        </label>
        {allgemeines && (
          <CategorySelect value={category} onChange={changeCategory} />
        )}
      </div>
    </Card>
  );
}

function formatRunningStart(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
  if (sameDay) return hhmm;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}. ${hhmm}`;
}

// ────────────────────────── Day section ─────────────────────────

function DaySection({
  day,
  jiraConfigured,
  forceBooking,
  onPlay,
  onEdit,
  onSubmitJira,
}: {
  day: DayGroup;
  jiraConfigured: boolean;
  forceBooking: boolean;
  onPlay: (
    description: string,
    isAllgemeines: boolean,
    category: AllgemeinesCategory | null,
  ) => void;
  onEdit: (entry: EntryView) => void;
  onSubmitJira: () => void;
}) {
  const bookable = bookableCount(day, forceBooking);
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold">{day.label}</span>
          {day.unsubmittedCount > 0 && (
            <Badge tone="open">{day.unsubmittedCount} offen</Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span
            className="num text-[13px] tabular-nums"
            style={{ color: "var(--text-2)" }}
          >
            {formatHms(day.totalSeconds)}
          </span>
          {bookable > 0 && jiraConfigured && (
            <button
              type="button"
              onClick={onSubmitJira}
              className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white"
              style={{
                background: forceBooking ? "var(--neg)" : "var(--accent)",
              }}
            >
              Nach Jira buchen
            </button>
          )}
        </div>
      </div>

      <Card padded={false}>
        <div className="divide-y" style={{ borderColor: "var(--border)" }}>
          {day.groups.map((g) => (
            <GroupRow
              key={g.description + g.entries[0].id}
              group={g}
              onPlay={onPlay}
              onEdit={onEdit}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function GroupRow({
  group,
  onPlay,
  onEdit,
}: {
  group: DescGroup;
  onPlay: (
    description: string,
    isAllgemeines: boolean,
    category: AllgemeinesCategory | null,
  ) => void;
  onEdit: (entry: EntryView) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSingle = group.entries.length === 1;
  const singleEntry = isSingle ? group.entries[0] : null;
  const [pendingDelete, setPendingDelete] = useState(false);

  async function onDeleteSingle() {
    if (!singleEntry || pendingDelete) return;
    if (!confirm("Diesen Eintrag wirklich löschen?")) return;
    setPendingDelete(true);
    try {
      await deleteEntry(singleEntry.id);
    } finally {
      setPendingDelete(false);
    }
  }

  return (
    <div>
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          type="button"
          onClick={() => !isSingle && setOpen((v) => !v)}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[11px] font-semibold"
          style={{
            background: "var(--surface-2)",
            color: "var(--text-2)",
            cursor: isSingle ? "default" : "pointer",
          }}
          aria-label={isSingle ? undefined : "Einträge anzeigen"}
        >
          {group.entries.length}
        </button>

        <div className="min-w-0 flex-1">
          <div className="text-[14px] truncate">
            {group.description || "(ohne Beschreibung)"}
          </div>
          <div
            className="text-[12px] font-semibold"
            style={{
              color: group.isAllgemeines
                ? "var(--teal)"
                : group.issueKey
                  ? "var(--accent)"
                  : "var(--text-3)",
            }}
          >
            {group.isAllgemeines
              ? `Allgemein · ${group.category ?? "—"}`
              : (group.issueKey ?? "kein Issue-Key")}
          </div>
        </div>

        {group.isAllgemeines ? (
          <Badge tone="default">nicht buchen</Badge>
        ) : (
          <Badge tone={group.allSubmitted ? "booked" : "open"}>
            {group.allSubmitted ? "gebucht" : "offen"}
          </Badge>
        )}
        <div className="num text-[14px] font-semibold tabular-nums min-w-[78px] text-right">
          {formatHms(group.totalSeconds)}
        </div>
        <IconButton
          title="Mit gleicher Beschreibung neu starten"
          onClick={() =>
            onPlay(group.description, group.isAllgemeines, group.category)
          }
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-[14px] w-[14px]">
            <path d="M8 5v14l11-7z" />
          </svg>
        </IconButton>
        {singleEntry && (
          <>
            <IconButton title="Bearbeiten" onClick={() => onEdit(singleEntry)}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-[13px] w-[13px]"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </IconButton>
            <IconButton title="Löschen" onClick={onDeleteSingle}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-[13px] w-[13px]"
              >
                <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
              </svg>
            </IconButton>
          </>
        )}
      </div>

      {open && !isSingle && (
        <div style={{ background: "var(--surface-2)" }}>
          {group.entries.map((e) => (
            <EntryRow key={e.id} entry={e} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  onEdit,
}: {
  entry: EntryView;
  onEdit: (entry: EntryView) => void;
}) {
  const [pending, setPending] = useState(false);
  async function onDelete() {
    if (pending) return;
    if (!confirm("Diesen Eintrag wirklich löschen?")) return;
    setPending(true);
    try {
      await deleteEntry(entry.id);
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 pl-12 text-[13px]"
      style={{ color: "var(--text-2)" }}
    >
      <div className="flex-1 num">
        {clockTime(entry.startedAt)} – {entry.endedAt ? clockTime(entry.endedAt) : "…"}
      </div>
      <div className="num font-semibold" style={{ color: "var(--text)" }}>
        {formatHms(entry.effectiveSeconds)}
      </div>
      <IconButton title="Bearbeiten" onClick={() => onEdit(entry)}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-[13px] w-[13px]"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      </IconButton>
      <IconButton title="Löschen" onClick={onDelete}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-[13px] w-[13px]"
        >
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
        </svg>
      </IconButton>
    </div>
  );
}

// ───────────────────────────── UI bits ─────────────────────────────

function IconButton({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-md border transition-colors"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface)",
        color: "var(--text-2)",
      }}
    >
      {children}
    </button>
  );
}

function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const styles =
    variant === "primary"
      ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
      : variant === "danger"
        ? {
            background: "var(--surface)",
            color: "var(--neg)",
            borderColor: "var(--neg)",
          }
        : {
            background: "var(--surface)",
            color: "var(--text)",
            borderColor: "var(--border-strong)",
          };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border px-3.5 py-2 text-[13px] font-semibold transition-opacity disabled:opacity-60"
      style={styles}
    >
      {children}
    </button>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl border"
        style={{
          background: "var(--surface)",
          borderColor: "var(--border)",
          boxShadow: "var(--shadow-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="text-[15px] font-semibold">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="text-[18px]"
            style={{ color: "var(--text-3)" }}
            aria-label="Schließen"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ───────────────────────── Datetime helpers ─────────────────────────

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value: string): string {
  return new Date(value).toISOString();
}

function defaultStartedAt(): string {
  const d = new Date();
  d.setHours(d.getHours() - 1, d.getMinutes(), 0, 0);
  return toLocalInputValue(d.toISOString());
}

function defaultEndedAt(): string {
  return toLocalInputValue(new Date().toISOString());
}

// ───────────────────────── Manual entry dialog ─────────────────────

function ManualEntryDialog({ onClose }: { onClose: () => void }) {
  const [description, setDescription] = useState("");
  const [startedAt, setStartedAt] = useState(defaultStartedAt());
  const [endedAt, setEndedAt] = useState(defaultEndedAt());
  const [isAllgemeines, setIsAllgemeines] = useState(false);
  const [category, setCategory] = useState<AllgemeinesCategory>(DEFAULT_CATEGORY);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSave() {
    setPending(true);
    setError(null);
    try {
      const res = await createManualEntry({
        description,
        startedAt: fromLocalInputValue(startedAt),
        endedAt: fromLocalInputValue(endedAt),
        isAllgemeines,
        category: isAllgemeines ? category : null,
      });
      if (res.ok) onClose();
      else setError(res.message ?? "Speichern fehlgeschlagen.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title="Eintrag manuell anlegen" onClose={onClose}>
      <div className="space-y-3.5">
        <Field label="Beschreibung">
          <TextInput
            value={description}
            onChange={setDescription}
            placeholder={
              isAllgemeines
                ? "Worklogtext für Allgemeines"
                : "Merksatz  TXR-1234  Worklogtext"
            }
          />
        </Field>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={isAllgemeines}
              onChange={(e) => setIsAllgemeines(e.target.checked)}
            />
            <span style={{ color: "var(--text-2)" }}>
              Als Allgemein speichern (nicht nach Jira buchen)
            </span>
          </label>
          {isAllgemeines && (
            <CategorySelect value={category} onChange={setCategory} />
          )}
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Beginn">
            <TextInput type="datetime-local" value={startedAt} onChange={setStartedAt} />
          </Field>
          <Field label="Ende">
            <TextInput type="datetime-local" value={endedAt} onChange={setEndedAt} />
          </Field>
        </div>
        {error && (
          <div className="text-[13px]" style={{ color: "var(--neg)" }}>
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2.5 pt-2">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={onSave} disabled={pending}>
            Speichern
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── Edit entry dialog ───────────────────────

function EditEntryDialog({
  entry,
  onClose,
}: {
  entry: EntryView;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(entry.description);
  const [startedAt, setStartedAt] = useState(toLocalInputValue(entry.startedAt));
  const [endedAt, setEndedAt] = useState(
    entry.endedAt ? toLocalInputValue(entry.endedAt) : defaultEndedAt(),
  );
  const [isAllgemeines, setIsAllgemeines] = useState(entry.isAllgemeines);
  const [category, setCategory] = useState<AllgemeinesCategory>(
    entry.category ?? DEFAULT_CATEGORY,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSave() {
    setPending(true);
    setError(null);
    try {
      const res = await updateEntry(entry.id, {
        description,
        startedAt: fromLocalInputValue(startedAt),
        endedAt: fromLocalInputValue(endedAt),
        isAllgemeines,
        category: isAllgemeines ? category : null,
      });
      if (res.ok) onClose();
      else setError(res.message ?? "Speichern fehlgeschlagen.");
    } finally {
      setPending(false);
    }
  }

  async function onDelete() {
    if (!confirm("Diesen Eintrag wirklich löschen?")) return;
    setPending(true);
    try {
      await deleteEntry(entry.id);
      onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title="Eintrag bearbeiten" onClose={onClose}>
      <div className="space-y-3.5">
        <Field label="Beschreibung">
          <TextInput value={description} onChange={setDescription} />
        </Field>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={isAllgemeines}
              onChange={(e) => setIsAllgemeines(e.target.checked)}
            />
            <span style={{ color: "var(--text-2)" }}>
              Als Allgemein speichern (nicht nach Jira buchen)
            </span>
          </label>
          {isAllgemeines && (
            <CategorySelect value={category} onChange={setCategory} />
          )}
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Beginn">
            <TextInput type="datetime-local" value={startedAt} onChange={setStartedAt} />
          </Field>
          <Field label="Ende">
            <TextInput type="datetime-local" value={endedAt} onChange={setEndedAt} />
          </Field>
        </div>
        {entry.submittedAt && (
          <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
            Bereits nach Jira übertragen ({entry.jiraIssueKey}). Änderungen wirken nur lokal.
          </div>
        )}
        {error && (
          <div className="text-[13px]" style={{ color: "var(--neg)" }}>
            {error}
          </div>
        )}
        <div className="flex justify-between gap-2.5 pt-2">
          <Button variant="danger" onClick={onDelete} disabled={pending}>
            Löschen
          </Button>
          <div className="flex gap-2.5">
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" onClick={onSave} disabled={pending}>
              Speichern
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── Jira submit dialog ──────────────────────

function JiraSubmitDialog({
  scope,
  bookingMode,
  forceBooking,
  onClose,
}: {
  scope: JiraScope;
  bookingMode: "grouped" | "individual";
  forceBooking: boolean;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<DayBookingPlan | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loader =
      scope.kind === "all"
        ? previewAllOpenBooking()
        : previewDayBooking(scope.dayKey);
    loader.then((p) => {
      if (!cancelled) setPlan(p);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  async function onConfirm() {
    setPending(true);
    try {
      const res =
        scope.kind === "all"
          ? await submitAllOpenToJira()
          : await submitDayToJira(scope.dayKey);
      setResult(res);
    } finally {
      setPending(false);
    }
  }

  const title =
    scope.kind === "all"
      ? "Alle offenen Einträge nach Jira buchen"
      : `Nach Jira buchen — ${scope.label}`;

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-[12px]" style={{ color: "var(--text-2)" }}>
          Modus:{" "}
          {bookingMode === "grouped"
            ? "Einträge gleicher Beschreibung werden gebündelt."
            : "Jeder Eintrag wird einzeln als Worklog gebucht."}
        </div>

        {forceBooking && (
          <div
            className="rounded-lg border px-3 py-2 text-[12.5px] font-semibold"
            style={{
              background: "var(--neg-soft)",
              borderColor: "var(--neg)",
              color: "var(--neg)",
            }}
          >
            Force-Buchung: Auch bereits gebuchte Einträge werden erneut nach Jira
            übertragen — das kann zu doppelten Worklogs führen.
          </div>
        )}

        {plan === null ? (
          <div className="text-[13px]" style={{ color: "var(--text-2)" }}>
            Vorschau wird geladen…
          </div>
        ) : (
          <>
            <div>
              <div
                className="text-[11px] uppercase tracking-wider pb-1.5"
                style={{ color: "var(--text-3)" }}
              >
                Worklogs ({plan.worklogs.length})
              </div>
              {plan.worklogs.length === 0 ? (
                <div className="text-[13px]" style={{ color: "var(--text-2)" }}>
                  Nichts zu buchen.
                </div>
              ) : (
                <div
                  className="rounded-lg border divide-y"
                  style={{
                    background: "var(--surface-2)",
                    borderColor: "var(--border)",
                  }}
                >
                  {plan.worklogs.map((w, i) => (
                    <div key={i} className="px-3 py-2 text-[13px]">
                      <div className="flex items-center justify-between">
                        <span
                          className="font-semibold"
                          style={{ color: "var(--accent)" }}
                        >
                          {w.issueKey}
                        </span>
                        <span className="num font-semibold tabular-nums">
                          {w.timeSpent}
                        </span>
                      </div>
                      {w.comment && (
                        <div
                          className="text-[12px] mt-0.5"
                          style={{ color: "var(--text-2)" }}
                        >
                          {w.comment}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {plan.skipped.length > 0 && (
              <div>
                <div
                  className="text-[11px] uppercase tracking-wider pb-1.5"
                  style={{ color: "var(--text-3)" }}
                >
                  Übersprungen ({plan.skipped.length})
                </div>
                <div
                  className="rounded-lg border divide-y"
                  style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
                >
                  {plan.skipped.map((s, i) => (
                    <div key={i} className="px-3 py-2 text-[12.5px]">
                      <div className="truncate">{s.description}</div>
                      <div style={{ color: "var(--warn)" }}>{s.reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {result && (
          <div
            className="rounded-lg border p-3 text-[13px]"
            style={{
              background: result.ok ? "var(--pos-soft)" : "var(--neg-soft)",
              borderColor: result.ok ? "var(--pos)" : "var(--neg)",
              color: result.ok ? "var(--pos)" : "var(--neg)",
            }}
          >
            <div className="font-semibold mb-1">
              {result.ok
                ? `Erfolgreich gebucht: ${result.bookedWorklogs} Worklog(s), ${result.bookedEntries} Eintrag/Einträge.`
                : result.message ?? "Buchung mit Fehlern."}
            </div>
            {result.errors.map((e, i) => (
              <div key={i} className="text-[12px]">
                {e}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2.5 pt-1">
          <Button onClick={onClose}>
            {result?.ok ? "Schließen" : "Abbrechen"}
          </Button>
          {!result?.ok && (
            <Button
              variant="primary"
              onClick={onConfirm}
              disabled={
                pending || plan === null || plan.worklogs.length === 0
              }
            >
              {pending ? "Buche…" : "Jetzt buchen"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────────── Form bits ───────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[12px] mb-1.5" style={{ color: "var(--text-2)" }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
      style={{
        background: "var(--surface-2)",
        borderColor: "var(--border-strong)",
        color: "var(--text)",
      }}
    />
  );
}
