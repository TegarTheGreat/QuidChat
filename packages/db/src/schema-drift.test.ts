import { getTableColumns, getTableName, is, Table } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import * as schema from "./schema.js"
import type { QuidDb } from "./client.js"
import { sql } from "drizzle-orm"

/**
 * The Drizzle model against the migrated database.
 *
 * The migrations are the source of truth and the model is a second description of the same
 * tables, which means they can disagree. They disagree silently in one direction and loudly in
 * the other: a column the migrations have and the model lacks costs nothing until someone needs
 * it, while a column the MODEL declares and the database lacks fails at runtime, on whichever
 * insert happens to touch it first — in production, since nothing here would have caught it.
 *
 * Every table the model declares was in fact reachable this way. `channel_configs` was added to
 * the migrations and not to the model, and nothing noticed, because the code that writes it uses
 * raw SQL. This test is what notices.
 */

let db: QuidDb

beforeAll(async () => {
  db = await freshPglite()
})

/** The table objects in the schema module; it also exports types and helpers. */
function modelledTables(): Table[] {
  // `Object.values` of a module namespace is `unknown[]` as far as the compiler is concerned,
  // so the narrowing goes through unknown rather than being asserted on the union.
  return (Object.values(schema) as unknown[]).filter((value): value is Table => is(value, Table))
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

describe("the Drizzle model and the migrations", () => {
  it("declares no table or column the migrated database does not have", async () => {
    const actual = new Map<string, Set<string>>()
    for (const row of rowsOf(
      await db.execute(sql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `),
    )) {
      const table = row.table_name as string
      if (!actual.has(table)) actual.set(table, new Set())
      actual.get(table)!.add(row.column_name as string)
    }

    const missing: string[] = []
    for (const table of modelledTables()) {
      const name = getTableName(table)
      const columns = actual.get(name)
      if (!columns) {
        missing.push(`table ${name}`)
        continue
      }
      for (const column of Object.values(getTableColumns(table))) {
        if (!columns.has(column.name)) missing.push(`${name}.${column.name}`)
      }
    }

    expect(missing).toEqual([])
  })

  it("models every table that carries tenant data", async () => {
    // The other direction, narrowed to what matters. A table the migrations have and the model
    // does not is only a problem when someone wants to query it through Drizzle — but for a
    // tenant-scoped table that is a near certainty, and finding out by writing the model at the
    // moment you need it is how the two drift in the first place.
    const modelled = new Set(modelledTables().map((t) => getTableName(t)))
    const tenantScoped = rowsOf(
      await db.execute(sql`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
      `),
    ).map((r) => r.table_name as string)

    const unmodelled = [...new Set(tenantScoped)].filter((t) => !modelled.has(t))
    expect(unmodelled).toEqual([])
  })
})
