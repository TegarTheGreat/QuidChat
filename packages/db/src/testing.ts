import { createDb, type QuidDb } from "./client.js"
import { applyMigrations } from "./migrate.js"

/** Database PGlite bersih di memori, migrasi sudah diterapkan. */
export async function freshPglite(): Promise<QuidDb> {
  const db = await createDb({ kind: "pglite" })
  await applyMigrations(db)
  return db
}
