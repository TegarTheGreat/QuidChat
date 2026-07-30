import { createDb, type QuidDb } from "./client.js"
import { applyMigrations } from "./migrate.js"

/** A fresh in-memory PGlite database with migrations already applied. */
export async function freshPglite(): Promise<QuidDb> {
  const db = await createDb({ kind: "pglite" })
  await applyMigrations(db)
  return db
}
