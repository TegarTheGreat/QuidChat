import { PGlite } from "@electric-sql/pglite"
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"
import { MIGRATIONS } from "./migrations.generated.js"

/** The ledger of applied migrations. Deliberately not in the migrations themselves —
 *  it has to exist before the first one runs. */
const LEDGER = "_quidchat_migrations"

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * Applies any migration that has not been applied yet, in filename order.
 *
 * Tracking what has run is not an optimisation. Every command in the CLI opens the
 * database and calls this, so without a ledger the second command a user ever runs fails
 * with "relation tenants already exists" — the schema is fine, but the tool appears
 * broken. The same is true of any deployment that restarts a process.
 *
 * A whole migration runs as one block. Migrations contain many statements (CREATE TABLE,
 * DO $$ ... $$, and so on) separated by semicolons, so they cannot go through the normal
 * `db.execute()` — that parses the SQL as a single prepared statement and rejects content
 * containing more than one. Both drivers have an "unprepared" path for this case:
 * `PGlite#exec` and `postgres.Sql#unsafe`.
 *
 * The SQL comes from a generated module rather than from disk. An earlier version
 * resolved `../migrations` from this file's own module URL, which is correct only when
 * running from the source tree — bundled into a binary or copied into a container, that
 * path points elsewhere and the process dies on start with ENOENT. No test could catch
 * it, because tests always run from the source tree.
 *
 * `packages/db/migrations/*.sql` remains the source of truth: it is what a reviewer reads
 * and what an external database tool can run. `scripts/generate-migrations.mjs` copies it
 * into the module, and `migrate.test.ts` fails if the two ever drift.
 */
export async function applyMigrations(db: QuidDb): Promise<void> {
  await db.execute(
    sql.raw(`
      CREATE TABLE IF NOT EXISTS ${LEDGER} (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `),
  )

  const applied = new Set(
    rowsOf(await db.execute(sql.raw(`SELECT name FROM ${LEDGER}`))).map(
      (r) => r.name as string,
    ),
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue

    const client = db.$client
    if (client instanceof PGlite) {
      await client.exec(migration.sql)
    } else {
      await client.unsafe(migration.sql)
    }

    // Recorded only after the migration succeeded, so a failure part-way leaves the name
    // absent and the next run retries rather than skipping a half-applied schema.
    await db.execute(
      sql.raw(`INSERT INTO ${LEDGER} (name) VALUES ('${migration.name}')`),
    )
  }
}
