"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Card, PageHeader } from "@/components/ui";
import {
  cleanupOldEntries,
  setForceBooking,
  testJiraConnection,
  updateSettings,
  type SettingsInput,
} from "@/lib/actions";
import { formatSignedHmInput, parseSignedHm } from "@/lib/format";
import type { BreakWindow } from "@/lib/work-time";

type Initial = SettingsInput & {
  breaks: BreakWindow[];
  forceBooking: boolean;
};

function minutesToHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hmToMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (m >= 60) return null;
  return h * 60 + m;
}

export function EinstellungenForm({ initial }: { initial: Initial }) {
  const [regular, setRegular] = useState(minutesToHm(initial.regularWorkMinutes));
  const [target, setTarget] = useState(minutesToHm(initial.dailyTargetMinutes));
  const [breaks, setBreaks] = useState<BreakWindow[]>(initial.breaks);
  const [autoPause, setAutoPause] = useState(initial.autoPauseEnabled);
  const [bookingMode, setBookingMode] = useState<"grouped" | "individual">(
    initial.bookingMode,
  );
  const [retention, setRetention] = useState(String(initial.dataRetentionDays));
  const [jiraUrl, setJiraUrl] = useState(initial.jiraUrl);
  const [projectKeys, setProjectKeys] = useState<string[]>(
    initial.jiraProjectKeys,
  );
  const [newKey, setNewKey] = useState("");
  const [token, setToken] = useState(
    initial.jiraToken ?? initial.jiraPassword ?? "",
  );
  const [jUser, setJUser] = useState(initial.jiraUser ?? "");
  const [overtimeBaseline, setOvertimeBaseline] = useState(
    formatSignedHmInput(initial.overtimeBaselineMinutes),
  );
  const [themeMode, setThemeMode] = useState<"system" | "light" | "dark">(
    initial.themeMode,
  );
  const [sprintAnchorDate, setSprintAnchorDate] = useState(
    initial.sprintAnchorDate,
  );
  const [sprintLengthDays, setSprintLengthDays] = useState(
    String(initial.sprintLengthDays),
  );
  const [concreteTarget, setConcreteTarget] = useState(
    String(initial.concreteIssueTargetPercent),
  );
  const [forceBooking, setForceBookingState] = useState(initial.forceBooking);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  // Desktop (Electron) integration: only available when running in the app.
  const [isElectron, setIsElectron] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);

  useEffect(() => {
    const bridge = window.electron;
    if (!bridge) return;
    bridge.getAutoLaunch().then((enabled) => {
      setIsElectron(true);
      setAutoLaunch(enabled);
    });
  }, []);

  async function toggleAutoLaunch(next: boolean) {
    const bridge = window.electron;
    if (!bridge) return;
    setAutoLaunch(await bridge.setAutoLaunch(next));
  }

  const [saveStatus, setSaveStatus] = useState<{
    tone: "ok" | "err";
    msg: string;
  } | null>(null);
  const [testStatus, setTestStatus] = useState<{
    tone: "ok" | "err";
    msg: string;
  } | null>(null);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSave() {
    const regularMin = hmToMinutes(regular);
    const targetMin = hmToMinutes(target);
    if (regularMin === null || targetMin === null) {
      setSaveStatus({
        tone: "err",
        msg: "Bitte Zeiten im Format hh:mm angeben.",
      });
      return;
    }
    const baselineMin = parseSignedHm(overtimeBaseline);
    if (baselineMin === null) {
      setSaveStatus({
        tone: "err",
        msg: "Überstunden-Startwert bitte als ±hh:mm angeben.",
      });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sprintAnchorDate)) {
      setSaveStatus({
        tone: "err",
        msg: "Sprint-Ankerdatum bitte als YYYY-MM-DD angeben.",
      });
      return;
    }
    const sprintLen = Number(sprintLengthDays);
    if (!Number.isInteger(sprintLen) || sprintLen < 1 || sprintLen > 365) {
      setSaveStatus({
        tone: "err",
        msg: "Sprint-Länge bitte als ganze Zahl zwischen 1 und 365 angeben.",
      });
      return;
    }
    const targetPct = Number(concreteTarget);
    if (!Number.isInteger(targetPct) || targetPct < 0 || targetPct > 100) {
      setSaveStatus({
        tone: "err",
        msg: "Ziel-Prozentwert bitte als ganze Zahl zwischen 0 und 100 angeben.",
      });
      return;
    }
    setPending(true);
    try {
      const res = await updateSettings({
        regularWorkMinutes: regularMin,
        dailyTargetMinutes: targetMin,
        breaks,
        autoPauseEnabled: autoPause,
        bookingMode,
        dataRetentionDays: Number(retention) || initial.dataRetentionDays,
        jiraUrl,
        jiraProjectKeys: projectKeys,
        jiraAuthMode: "basic",
        jiraToken: token || null,
        jiraUser: jUser || null,
        jiraPassword: null,
        overtimeBaselineMinutes: baselineMin,
        themeMode,
        sprintAnchorDate,
        sprintLengthDays: sprintLen,
        concreteIssueTargetPercent: targetPct,
      });
      setSaveStatus(
        res.ok
          ? { tone: "ok", msg: "Einstellungen gespeichert." }
          : { tone: "err", msg: res.message ?? "Speichern fehlgeschlagen." },
      );
    } finally {
      setPending(false);
    }
  }

  async function onTest() {
    setTestStatus(null);
    setPending(true);
    try {
      const res = await testJiraConnection({
        jiraUrl,
        jiraToken: token || null,
        jiraUser: jUser || null,
      });
      setTestStatus({
        tone: res.ok ? "ok" : "err",
        msg: res.message ?? (res.ok ? "Verbindung erfolgreich." : "Fehler."),
      });
    } finally {
      setPending(false);
    }
  }

  async function onCleanup() {
    const days = Number(retention);
    if (!Number.isFinite(days) || days < 1) {
      setCleanupStatus("Bitte eine Zahl ≥ 1 angeben.");
      return;
    }
    if (
      !confirm(
        `Wirklich alle erfassten Einträge älter als ${days} Tage lokal löschen? Jira bleibt unberührt.`,
      )
    )
      return;
    setPending(true);
    try {
      const res = await cleanupOldEntries(days);
      setCleanupStatus(
        res.ok
          ? `${res.deleted} Eintrag/Einträge gelöscht.`
          : res.message ?? "Fehler beim Löschen.",
      );
    } finally {
      setPending(false);
    }
  }

  async function toggleForceBooking(next: boolean) {
    setForceBookingState(next);
    await setForceBooking(next);
  }

  function addBreak() {
    setBreaks((b) => [...b, { start: "12:00", end: "12:30" }]);
  }
  function updateBreak(i: number, patch: Partial<BreakWindow>) {
    setBreaks((b) => b.map((br, idx) => (idx === i ? { ...br, ...patch } : br)));
  }
  function removeBreak(i: number) {
    setBreaks((b) => b.filter((_, idx) => idx !== i));
  }

  function addKey() {
    const k = newKey.trim().toUpperCase();
    if (!k || projectKeys.includes(k)) return;
    setProjectKeys((keys) => [...keys, k]);
    setNewKey("");
  }
  function removeKey(k: string) {
    setProjectKeys((keys) => keys.filter((x) => x !== k));
  }

  return (
    <main className="px-8 py-7">
      <PageHeader
        title="Einstellungen"
        subtitle="Arbeitszeit, Pausen, Jira-Anbindung"
        actions={
          <button
            type="button"
            onClick={onSave}
            disabled={pending}
            className="rounded-lg border px-3.5 py-2 text-[13px] font-semibold transition-opacity disabled:opacity-60"
            style={{
              background: "var(--accent)",
              borderColor: "var(--accent)",
              color: "#fff",
            }}
          >
            Speichern
          </button>
        }
      />

      {saveStatus && (
        <div
          className="mb-4 rounded-lg border px-4 py-2.5 text-[13px]"
          style={{
            background:
              saveStatus.tone === "ok" ? "var(--pos-soft)" : "var(--neg-soft)",
            borderColor: saveStatus.tone === "ok" ? "var(--pos)" : "var(--neg)",
            color: saveStatus.tone === "ok" ? "var(--pos)" : "var(--neg)",
          }}
        >
          {saveStatus.msg}
        </div>
      )}

      <Section title="Arbeitszeit">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Regelarbeitszeit (hh:mm)">
            <TextInput value={regular} onChange={setRegular} placeholder="07:00" />
          </Field>
          <Field label="Tagesziel (hh:mm) — Default = Regelarbeitszeit">
            <TextInput value={target} onChange={setTarget} placeholder="07:00" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Überstunden-Startwert (±hh:mm)">
            <TextInput
              value={overtimeBaseline}
              onChange={setOvertimeBaseline}
              placeholder="+00:00"
            />
          </Field>
          <div className="text-[12px] self-end pb-2" style={{ color: "var(--text-3)" }}>
            Bereits vorhandenes Überstundensaldo, das vor dem Einsatz dieses Tools
            angefallen ist. Wird zum berechneten Saldo addiert.
          </div>
        </div>
      </Section>

      <Section title="Pausen">
        {breaks.length === 0 && (
          <div className="text-[13px] mb-2" style={{ color: "var(--text-2)" }}>
            Keine Pausen definiert.
          </div>
        )}
        {breaks.map((b, i) => (
          <div key={i} className="flex items-center gap-2.5 mb-2">
            <TextInput
              value={b.start}
              onChange={(v) => updateBreak(i, { start: v })}
              className="w-28"
            />
            <span style={{ color: "var(--text-3)" }}>bis</span>
            <TextInput
              value={b.end}
              onChange={(v) => updateBreak(i, { end: v })}
              className="w-28"
            />
            <button
              type="button"
              onClick={() => removeBreak(i)}
              className="rounded-md border px-2 py-1 text-[12px]"
              style={{
                borderColor: "var(--border-strong)",
                color: "var(--text-2)",
              }}
            >
              entfernen
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addBreak}
          className="mt-1 rounded-lg border px-3 py-1.5 text-[12px] font-semibold"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text)",
            background: "var(--surface-2)",
          }}
        >
          + Pause hinzufügen
        </button>

        <label className="mt-4 flex items-center gap-3">
          <input
            type="checkbox"
            checked={autoPause}
            onChange={(e) => setAutoPause(e.target.checked)}
          />
          <span className="text-[13px]">
            Pausenzeiten automatisch von der Arbeitszeit abziehen
          </span>
        </label>
      </Section>

      <Section title="Buchung">
        <Field label="Buchungsmodus">
          <Select
            value={bookingMode}
            onChange={(v) => setBookingMode(v as "grouped" | "individual")}
            options={[
              {
                value: "grouped",
                label: "Einträge gleicher Beschreibung gebündelt buchen",
              },
              { value: "individual", label: "Jeden Eintrag einzeln buchen" },
            ]}
          />
        </Field>
      </Section>

      <Section title="Darstellung">
        <Field label="Farbschema">
          <Select
            value={themeMode}
            onChange={(v) => setThemeMode(v as "system" | "light" | "dark")}
            options={[
              { value: "system", label: "Systemeinstellung übernehmen" },
              { value: "light", label: "Hell" },
              { value: "dark", label: "Dunkel" },
            ]}
          />
        </Field>
        <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
          Die Änderung greift sofort als Vorschau und wird mit „Speichern&rdquo;
          dauerhaft übernommen.
        </div>
      </Section>

      {isElectron && (
        <Section title="Desktop">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoLaunch}
              onChange={(e) => toggleAutoLaunch(e.target.checked)}
            />
            <span className="text-[13px]">
              JiraWorklog automatisch beim Windows-Anmelden starten
            </span>
          </label>
          <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
            Die App startet minimiert im System-Tray. Diese Einstellung wird
            sofort übernommen.
          </div>
        </Section>
      )}

      <Section title="Jira-Anbindung">
        <Field label="Jira-URL">
          <TextInput
            value={jiraUrl}
            onChange={setJiraUrl}
            placeholder="https://yourorg.atlassian.net"
          />
        </Field>
        <Field label="Projekt-Keys (für die Format-Auftrennung des Beschreibungstexts)">
          <div className="flex flex-wrap items-center gap-2">
            {projectKeys.map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                {k}
                <button
                  type="button"
                  onClick={() => removeKey(k)}
                  aria-label={`${k} entfernen`}
                  style={{ opacity: 0.7 }}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKey();
                }
              }}
              placeholder="z.B. TXR"
              className="rounded-md border px-2 py-1 text-[12px] w-24 outline-none"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--border-strong)",
                color: "var(--text)",
              }}
            />
            <button
              type="button"
              onClick={addKey}
              className="rounded-md border px-2 py-1 text-[12px]"
              style={{
                borderColor: "var(--border-strong)",
                color: "var(--text)",
                background: "var(--surface)",
              }}
            >
              + hinzufügen
            </button>
          </div>
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Atlassian-E-Mail">
            <TextInput
              value={jUser}
              onChange={setJUser}
              placeholder="name@example.com"
            />
          </Field>
          <Field label="API-Token">
            <TextInput value={token} onChange={setToken} type="password" />
          </Field>
          <Field label="&nbsp;">
            <button
              type="button"
              onClick={onTest}
              disabled={pending}
              className="w-full rounded-lg border px-3 py-2 text-[13px] font-semibold disabled:opacity-60"
              style={{
                background: "var(--surface)",
                borderColor: "var(--border-strong)",
                color: "var(--text)",
              }}
            >
              Verbindung testen
            </button>
          </Field>
        </div>
        <div className="text-[12px] -mt-1" style={{ color: "var(--text-3)" }}>
          Jira Cloud: API-Token unter{" "}
          <a
            href="https://id.atlassian.com/manage-profile/security/api-tokens"
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: "var(--accent)" }}
          >
            id.atlassian.com
          </a>{" "}
          erstellen (nicht das Kontopasswort verwenden).
        </div>
        {testStatus && (
          <div
            className="mt-3 rounded-lg border px-3 py-2 text-[12.5px]"
            style={{
              background:
                testStatus.tone === "ok" ? "var(--pos-soft)" : "var(--neg-soft)",
              borderColor: testStatus.tone === "ok" ? "var(--pos)" : "var(--neg)",
              color: testStatus.tone === "ok" ? "var(--pos)" : "var(--neg)",
            }}
          >
            {testStatus.msg}
          </div>
        )}
      </Section>

      <Section title="Sprint & KPI">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Sprint-Ankerdatum">
            <TextInput
              value={sprintAnchorDate}
              onChange={setSprintAnchorDate}
              type="date"
            />
          </Field>
          <Field label="Sprint-Länge (Tage)">
            <TextInput
              value={sprintLengthDays}
              onChange={setSprintLengthDays}
              type="number"
            />
          </Field>
          <Field label="Ziel konkrete Issues (%)">
            <TextInput
              value={concreteTarget}
              onChange={setConcreteTarget}
              type="number"
            />
          </Field>
        </div>
        <div className="mt-1 text-[12px]" style={{ color: "var(--text-3)" }}>
          Beliebiger Tag aus einem vergangenen oder aktuellen Sprint reicht als
          Anker — alle anderen Sprints werden daraus berechnet. Die Quote misst
          den Anteil der Zeit, die nicht auf „Allgemeines&rdquo; gebucht wurde.
        </div>
      </Section>

      <Section title="Datenpflege">
        <div className="grid grid-cols-3 gap-4 items-end">
          <Field label="Einträge löschen, älter als (Tage)">
            <TextInput value={retention} onChange={setRetention} type="number" />
          </Field>
          <div>
            <button
              type="button"
              onClick={onCleanup}
              disabled={pending}
              className="rounded-lg border px-3.5 py-2 text-[13px] font-semibold disabled:opacity-60"
              style={{
                background: "var(--surface)",
                borderColor: "var(--neg)",
                color: "var(--neg)",
              }}
            >
              Jetzt löschen
            </button>
          </div>
          <div />
        </div>
        <div className="mt-2 text-[12px]" style={{ color: "var(--text-3)" }}>
          Entfernt nur lokale Einträge aus der Datenbank. Jira-Worklogs bleiben unberührt.
        </div>
        {cleanupStatus && (
          <div className="mt-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
            {cleanupStatus}
          </div>
        )}
      </Section>

      <DangerSection title="Gefahrenzone">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={forceBooking}
            onChange={(e) => toggleForceBooking(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[13px]">
            <span className="font-semibold">Force-Buchung aktivieren</span> —
            erlaubt das erneute Senden bereits gebuchter Einträge an Jira.
          </span>
        </label>
        <div className="mt-2 text-[12px]" style={{ color: "var(--neg)" }}>
          Achtung: Dies kann doppelte Worklogs in Jira erzeugen. Die Einstellung
          wird nicht gespeichert und ist nach einem Neustart der App wieder
          deaktiviert.
        </div>
      </DangerSection>
    </main>
  );
}

function DangerSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-5">
      <div
        className="rounded-xl border p-5"
        style={{ background: "var(--neg-soft)", borderColor: "var(--neg)" }}
      >
        <div
          className="text-[14px] font-semibold mb-4"
          style={{ color: "var(--neg)" }}
        >
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-5">
      <Card>
        <div className="text-[14px] font-semibold mb-4">{title}</div>
        {children}
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block mb-3">
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
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`rounded-lg border px-3 py-2 text-[13px] outline-none ${className || "w-full"}`}
      style={{
        background: "var(--surface-2)",
        borderColor: "var(--border-strong)",
        color: "var(--text)",
      }}
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
      style={{
        background: "var(--surface-2)",
        borderColor: "var(--border-strong)",
        color: "var(--text)",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
