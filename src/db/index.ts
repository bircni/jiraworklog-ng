import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

// Single source of truth for the DB location. For a future Electron build this
// is the only line to change (e.g. to app.getPath("userData")).
const DB_PATH = process.env.JWL_DB_PATH ?? "./data/jiraworklog.db";
const IN_MEMORY = DB_PATH === ":memory:";

if (!IN_MEMORY) {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Migrations run on startup so a fresh checkout just works. In a packaged
// Electron build the process cwd is not the project root, so the migrations
// folder can be pointed at the bundled copy via JWL_MIGRATIONS_DIR.
const migrationsFolder =
  process.env.JWL_MIGRATIONS_DIR ?? resolve(process.cwd(), "drizzle");

const sleepSync = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Serialises migrations across processes with an exclusive lock file. During
 * `next build`, Turbopack spawns several workers that each import this module
 * and race to create + migrate a fresh DB (and the e2e global-setup migrates the
 * same file too). Concurrent `CREATE TABLE` from that race throws SQLITE_BUSY /
 * "already exists"; the lock lets exactly one migrator run at a time, so the
 * rest simply find the migrations already applied and no-op.
 */
function runMigrationsLocked(drizzleDb: ReturnType<typeof drizzle>): void {
  if (!existsSync(migrationsFolder)) return;
  if (IN_MEMORY) {
    // A `:memory:` DB is private to its single connection — no contention.
    migrate(drizzleDb, { migrationsFolder });
    return;
  }

  const lockPath = `${DB_PATH}.migrate.lock`;
  let waited = 0;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx"); // exclusive create; EEXIST if held
    } catch (err) {
      if ((err as { code?: string })?.code !== "EEXIST") throw err;
      // Break a stale lock left by a crashed holder after a generous timeout.
      if (waited >= 30_000) {
        try {
          unlinkSync(lockPath);
        } catch {
          // another worker already cleared it — retry the acquire
        }
        waited = 0;
        continue;
      }
      sleepSync(50);
      waited += 50;
      continue;
    }
    try {
      migrate(drizzleDb, { migrationsFolder });
      return;
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // best effort — a stale-lock breaker may have removed it
      }
    }
  }
}

function openConnection() {
  const sqlite = new Database(DB_PATH);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 10000");
    const drizzleDb = drizzle(sqlite, { schema, casing: "snake_case" });
    runMigrationsLocked(drizzleDb);
    return { sqlite, db: drizzleDb };
  } catch (err) {
    // Close the half-open handle so a retry doesn't leak connections that
    // would themselves hold locks and deepen the contention.
    sqlite.close();
    throw err;
  }
}

type Connection = ReturnType<typeof openConnection>;

// The migration itself is serialised by the lock above; the WAL-mode switch on
// open can still momentarily contend, so retry a SQLITE_BUSY there too.
function connect(): Connection {
  for (let attempt = 0; ; attempt++) {
    try {
      return openConnection();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "SQLITE_BUSY" || attempt >= 20) throw err;
      sleepSync(Math.min(1000, 100 * (attempt + 1)));
    }
  }
}

export const db = connect().db;

export { schema };
