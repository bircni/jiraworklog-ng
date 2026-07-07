import { stopTimer } from "@/lib/actions";
import { assertLocalSecret } from "@/lib/electron-ipc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Internal endpoint consumed by the Electron tray's "Stop timer" action. Reuses
 * the same `stopTimer()` server action as the UI so the sub-minute discard and
 * break-adjustment rules stay in one place. Guarded by the shared secret.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = assertLocalSecret(request);
  if (denied) return denied;

  const result = await stopTimer();
  return Response.json(result);
}
