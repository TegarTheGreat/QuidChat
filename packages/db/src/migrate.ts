import { PGlite } from "@electric-sql/pglite"
import type { QuidDb } from "./client.js"
import { MIGRATIONS } from "./migrations.generated.js"

/**
 * Runs the entire contents of a migration as a single block. Migrations contain many
 * statements (CREATE TABLE, DO $$ ... $$, and so on) separated by semicolons, so they
 * can't go through the normal `db.execute()` — that parses the SQL as a single prepared
 * statement and rejects content containing more than one. Both drivers have their own
 * "unprepared" path for this case: `PGlite#exec` and `postgres.Sql#unsafe`.
 *
 * The SQL comes from a generated module rather than being read from disk. An earlier
 * version resolved `../migrations` from this file's own module URL, which is correct only
 * when running from the source tree — bundled into a binary or copied into a container,
 * that path points somewhere else and the process dies on start with ENOENT. No test
 * could catch it, because tests always run from the source tree.
 *
 * `packages/db/migrations/*.sql` remains the source of truth: it is what a reviewer reads
 * and what an external database tool can run. `scripts/generate-migrations.mjs` copies it
 * into the module, and `migrate.test.ts` fails if the two ever drift.
 */
export async function applyMigrations(db: QuidDb): Promise<void> {
  // Already ordered by name in the generated module. Order matters: migrations are
  // applied in filename order.
  for (const migration of MIGRATIONS) {
    const client = db.$client
    if (client instanceof PGlite) {
      await client.exec(migration.sql)
    } else {
      await client.unsafe(migration.sql)
    }
  }
}
