import { timingSafeEqual } from "node:crypto";

/**
 * Header carrying the per-launch shared secret that the Electron main process
 * uses to authenticate its calls to the internal timer endpoints.
 */
export const IPC_SECRET_HEADER = "x-jwl-secret";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Guards the Electron-only internal API routes. The server is bound to
 * 127.0.0.1 and every legitimate request carries the shared secret that the
 * main process generated for this launch. Fails closed: if no secret is
 * configured (i.e. not running under Electron), the endpoints are unavailable.
 *
 * Returns a `Response` to send back when the request is not authorised, or
 * `null` when the caller may proceed.
 */
export function assertLocalSecret(request: Request): Response | null {
  const expected = process.env.JWL_IPC_SECRET;
  if (!expected) {
    return new Response("Not found", { status: 404 });
  }
  const provided = request.headers.get(IPC_SECRET_HEADER);
  if (!provided || !safeEqual(provided, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
