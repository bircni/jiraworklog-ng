import { getRunningEntry, getSettings } from "@/db/queries";
import { assertLocalSecret } from "@/lib/electron-ipc";
import { effectiveDurationSeconds, parseBreaks } from "@/lib/work-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Internal endpoint consumed by the Electron tray to show the live timer. Not
 * part of the web UI; guarded by the per-launch shared secret.
 */
export function GET(request: Request): Response {
  const denied = assertLocalSecret(request);
  if (denied) return denied;

  const running = getRunningEntry();
  if (!running) {
    return Response.json({ running: false });
  }

  const s = getSettings();
  const effectiveSeconds = effectiveDurationSeconds(
    running.startedAt,
    null,
    parseBreaks(s.breaks),
    s.autoPauseEnabled,
  );

  return Response.json({
    running: true,
    description: running.description,
    startedAt: running.startedAt,
    isAllgemeines: running.isAllgemeines,
    category: running.category,
    effectiveSeconds,
  });
}
