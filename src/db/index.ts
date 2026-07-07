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

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
// During `next build` Turbopack spawns multiple workers that each instantiate
// the DB module concurrently — make writers queue rather than fail.
sqlite.pragma("busy_timeout = 10000");

export const db = drizzle(sqlite, { schema, casing: "snake_case" });

// Apply pending migrations on startup so a fresh checkout just works. In a
// packaged Electron build the process cwd is not the project root, so the
// migrations folder can be pointed at the bundled copy via JWL_MIGRATIONS_DIR.
const migrationsFolder =
  process.env.JWL_MIGRATIONS_DIR ?? resolve(process.cwd(), "drizzle");
if (existsSync(migrationsFolder)) {
  migrate(db, { migrationsFolder });
}

export { schema };
