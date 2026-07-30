import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import type { QuidDb } from "./client.js"

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/**
 * Menjalankan seluruh isi file migrasi sebagai satu blok. File migrasi berisi
 * banyak statement (CREATE TABLE, DO $$ ... $$, dst) dipisah titik koma, jadi
 * tidak bisa lewat `db.execute()` biasa — itu mem-parse SQL sebagai satu
 * prepared statement dan menolak isi yang berisi lebih dari satu statement.
 * Kedua driver punya jalur "unprepared" masing-masing untuk kasus ini:
 * `PGlite#exec` dan `postgres.Sql#unsafe`.
 */
export async function applyMigrations(db: QuidDb): Promise<void> {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
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
