import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { MIGRATIONS } from "./migrations.generated.js"

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/**
 * The generated module and the .sql files must never drift.
 *
 * The SQL is embedded in TypeScript so applying migrations does not depend on a
 * filesystem path — a path relative to the module is correct only when running from the
 * source tree, and a bundled or containerised deployment dies on start with ENOENT
 * instead. But embedding creates a second copy, and a second copy can go stale: someone
 * edits the .sql, runs the tests from the source tree where everything looks fine, and
 * ships a binary that applies the old schema.
 *
 * This test is the only thing standing between that edit and that binary.
 */
describe("generated migrations", () => {
  it("matches the .sql files exactly", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).toSorted()

    expect(MIGRATIONS.map((m) => m.name)).toEqual(files)

    for (const migration of MIGRATIONS) {
      const onDisk = readFileSync(join(migrationsDir, migration.name), "utf8")
      // If this fails, run `pnpm generate:migrations`.
      expect(migration.sql).toBe(onDisk)
    }
  })

  it("carries at least one migration", () => {
    // A generator bug that produced an empty array would leave every database
    // unmigrated, and every other test would then fail confusingly rather than here.
    expect(MIGRATIONS.length).toBeGreaterThan(0)
  })
})
