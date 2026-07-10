import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

// Single source of truth for the DB location. For a future Electron build this
// is the only line to change (e.g. to app.getPath("userData")).
const DB_PATH = process.env.JWL_DB_PATH ?? "./data/jiraworklog.db";

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

// Migrations run on startup so a fresh checkout just works. In a packaged
// Electron build the process cwd is not the project root, so the migrations
// folder can be pointed at the bundled copy via JWL_MIGRATIONS_DIR.
const migrationsFolder =
  process.env.JWL_MIGRATIONS_DIR ?? resolve(process.cwd(), "drizzle");

type Connection = ReturnType<typeof openConnection>;

function openConnection() {
  const sqlite = new Database(DB_PATH);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 10000");
    const drizzleDb = drizzle(sqlite, { schema, casing: "snake_case" });
    if (existsSync(migrationsFolder)) {
      migrate(drizzleDb, { migrationsFolder });
    }
    return { sqlite, db: drizzleDb };
  } catch (err) {
    // Close the half-open handle so a retry doesn't leak connections that
    // would themselves hold locks and deepen the contention.
    sqlite.close();
    throw err;
  }
}

// `next build` collects page data with several Turbopack workers that each
// import this module and race to create + migrate a fresh DB. Two failure
// modes arise: the WAL switch / write-lock upgrade returns SQLITE_BUSY, and two
// workers both applying the first migration collide on `CREATE TABLE` ("already
// exists"). drizzle runs each migration in a BEGIN…COMMIT with ROLLBACK on
// error, so a losing worker leaves no partial state — retrying the whole init
// converges: exactly one worker commits, the rest then see the recorded
// migration and open as a no-op.
function isConcurrentInitError(err: unknown): boolean {
  const { code, message } = (err ?? {}) as { code?: string; message?: string };
  if (code === "SQLITE_BUSY") return true;
  return code === "SQLITE_ERROR" && /already exists/i.test(message ?? "");
}

function connect(): Connection {
  const sleepSync = (ms: number) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let attempt = 0; ; attempt++) {
    try {
      return openConnection();
    } catch (err) {
      if (!isConcurrentInitError(err) || attempt >= 20) throw err;
      sleepSync(Math.min(1000, 100 * (attempt + 1)));
    }
  }
}

export const db = connect().db;

export { schema };
