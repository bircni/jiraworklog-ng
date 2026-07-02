import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy (formerly "middleware") that shields the app from the constant
 * background noise of automated vulnerability scanners (PHP/CGI/ASP probes,
 * path traversal, SQLi, command injection, ...) and from request floods.
 *
 * It runs before any route handler, so scanner probes get a cheap 404 without
 * ever touching application code.
 *
 * Limitations: the counters live in process memory. They reset on restart and
 * are NOT shared across multiple instances. For a self-hosted single-node
 * deployment that is enough; anything larger should sit behind a real WAF /
 * reverse proxy (Cloudflare, nginx limit_req, fail2ban, ...).
 */

// Paths that almost certainly belong to a scanner probing for a different tech
// stack than this Next.js app (there is no PHP/CGI/ASP/etc. here).
const SCAN_PATH =
  /(?:\.(?:php\d?|cgi|asp|aspx|jsp|pl|dll|env|bak|sql|ini)(?:$|[/?])|\/(?:cgi-bin|scripts|vendor|wp-admin|wp-login|wp-content|xmlrpc|phpmyadmin|web-inf|\.git|\.aws|\.ssh|\.vscode)(?:$|[/?])|boot\.ini|etc\/passwd)/i;

// Query/path payloads typical of injection & traversal attempts.
const SCAN_PAYLOAD =
  /(?:\|id\||\bsystem\s*\(|union\s+select|\.\.(?:%2f|\/)|%00|config\[incdir\]|onerror\s*=)/i;

// Generous global rate limit. Real usage (SPA navigation + PDF generation)
// bursts well below this once static assets are excluded (see matcher).
const RATE_LIMIT = 120; // requests ...
const RATE_WINDOW_MS = 10_000; // ... per 10s per IP.

// An IP that trips a scan pattern this many times gets parked for BAN_MS.
const SCAN_STRIKES = 3;
const BAN_MS = 10 * 60_000;

// --- In-memory state (single process only) -------------------------------
const hits = new Map<string, number[]>();
const strikes = new Map<string, number>();
const bannedUntil = new Map<string, number>();

let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [ip, times] of hits) {
    if (!times.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(ip);
  }
  for (const [ip, until] of bannedUntil) {
    if (until <= now) bannedUntil.delete(ip);
  }
  strikes.clear();
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function isRateLimited(ip: string, now: number): boolean {
  const times = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  times.push(now);
  hits.set(ip, times);
  return times.length > RATE_LIMIT;
}

export function proxy(req: NextRequest): NextResponse {
  const now = Date.now();
  sweep(now);

  const ip = clientIp(req);

  const ban = bannedUntil.get(ip);
  if (ban && ban > now) {
    return new NextResponse(null, { status: 404 });
  }

  const { pathname, search } = req.nextUrl;
  if (SCAN_PATH.test(pathname) || SCAN_PAYLOAD.test(pathname + search)) {
    const n = (strikes.get(ip) ?? 0) + 1;
    if (n >= SCAN_STRIKES) {
      bannedUntil.set(ip, now + BAN_MS);
      strikes.delete(ip);
    } else {
      strikes.set(ip, n);
    }
    return new NextResponse(null, { status: 404 });
  }

  if (isRateLimited(ip, now)) {
    return new NextResponse("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
    });
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals & static assets. This keeps the
  // overhead off asset loads and prevents them from counting toward the limit.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
