import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import type { QuidDb } from "./client.js"

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/**
 * Runs the entire contents of a migration file as a single block. Migration
 * files contain many statements (CREATE TABLE, DO $$ ... $$, etc.) separated
 * by semicolons, so they can't go through the normal `db.execute()` — that
 * parses the SQL as a single prepared statement and rejects content
 * containing more than one statement. Both drivers have their own
 * "unprepared" path for this case: `PGlite#exec` and `postgres.Sql#unsafe`.
 */
export async function applyMigrations(db: QuidDb): Promise<void> {
  // `toSorted()` so the migration order visibly comes from a new array, not
  // from a side effect. The order matters: migrations are applied by file name.
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).toSorted()
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), "utf8")
    const client = db.$client
    if (client instanceof PGlite) {
      await client.exec(body)
    } else {
      await client.unsafe(body)
    }
  }
}
