/**
 * Tests that ATTACK tenant isolation, then demand the defenses actually fire.
 *
 * The final review of Plan 1 found the flaw not by reading the code, but by
 * breaking it and watching the suite stay green. The first attack used: adding
 * `CREATE POLICY leak ON tenant_settings USING (true)` ALONGSIDE the scoping
 * policy. Postgres combines permissive policies with OR, so isolation collapsed
 * while the correct policy was still in place — and at the time, ZERO tests
 * failed. The Plan 2 review found two more attacks the same way, both of which
 * slipped past the guard version at the time (see the second `describe` below).
 *
 * This file makes those attacks a permanent part of the suite. There are three
 * layers of defense:
 *
 *   1. The guard in the migration (the `guard_isolation` block), which rejects
 *      ANY RLS-enabled table whose permissive policy — on `qual` or
 *      `with_check` — is not EXACTLY `(key = current_tenant_id())`. The guard
 *      is EXTRACTED DIRECTLY from the migration file rather than copied here —
 *      if someone weakens the guard, this test is what fails.
 *   2. `getTenantConfig`, which rejects a result of more than one row. Without
 *      that, the code would silently take the first row, which could belong to
 *      another tenant — and because every tenant's defaults are identical on a
 *      fresh install, no ordinary assertion would notice.
 *   3. The behavioral tests in the second `describe`, which measure the effect
 *      through real queries rather than the text shape of a policy — see its
 *      docstring for the exact coverage.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { tenants, tenantSettings } from "./schema.js"
import { createStore } from "./store.js"
import { withTenant } from "./tenant.js"
import { freshPglite } from "./testing.js"

/** Normalizes the `execute()` result: the PGlite driver returns `{rows}`, postgres-js an Array. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/** Extracts a single `DO $name$ ... END $name$;` block from the applied migration file. */
function guardBlock(name: string): string {
  const migration = readFileSync(
    join(process.cwd(), "packages/db/migrations/0001_init.sql"),
    "utf8",
  )
  const open = `DO $${name}$`
  const close = `END $${name}$;`
  const start = migration.indexOf(open)
  if (start === -1) throw new Error(`block ${open} not found in migration`)
  return migration.slice(start, migration.indexOf(close, start) + close.length)
}

describe("tenant isolation under attack", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let tenantA: string
  let guard: string

  beforeAll(async () => {
    db = await freshPglite()
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A" }).returning()
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B" }).returning()
    tenantA = a!.id
    // Two tenants, both with settings. A single tenant wouldn't be enough: a leak
    // is only visible if there's another tenant's data that could leak.
    await db.insert(tenantSettings).values({ tenantId: a!.id })
    await db.insert(tenantSettings).values({ tenantId: b!.id })
    guard = guardBlock("guard_isolation")
  })

  it("migration guard passes on a healthy schema", async () => {
    await expect(db.execute(sql.raw(guard))).resolves.toBeDefined()
  })

  it("getTenantConfig works normally on a healthy schema", async () => {
    const cfg = await createStore(db).getTenantConfig(tenantA)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
  })

  it("migration guard REJECTS a leaked policy added alongside", async () => {
    await db.execute(sql`CREATE POLICY leak ON tenant_settings USING (true)`)
    // If this assertion fails, the guard has been weakened and an isolation leak
    // could land through a migration with nobody noticing.
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
  })

  it("getTenantConfig THROWS instead of reading another tenant's settings", async () => {
    // The leaky policy from the previous test is still in place; that's exactly what's being tested.
    await expect(createStore(db).getTenantConfig(tenantA)).rejects.toThrow(
      "tenant isolation failed",
    )
    await db.execute(sql`DROP POLICY leak ON tenant_settings`)
  })

  it("migration guard REJECTS a policy that only MENTIONS current_tenant_id()", async () => {
    // The attack that defeated the second version of the guard. `USING (current_tenant_id()
    // IS NOT NULL)` mentions the function without restricting a single row, so a
    // "contains" check would pass while the table sits wide open. A substring check can
    // never prove a policy is actually restrictive — the guard now demands an EXACT
    // expression, and this test is what keeps it that way.
    await db.execute(
      sql`CREATE POLICY leak_mentions ON conversations USING (current_tenant_id() IS NOT NULL)`,
    )
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY leak_mentions ON conversations`)
  })

  it("guard rejects a leaked with_check — the WRITE path", async () => {
    // The previous version of the guard only checked `qual`, the READ path. With
    // `WITH CHECK (true)` a tenant can WRITE rows belonging to another tenant:
    // measured, one usage_events row of 500,000 cents landed in someone else's
    // ledger, and one fake assistant message landed in another business's transcript.
    await db.execute(sql`DROP POLICY tenant_isolation ON usage_events`)
    await db.execute(sql`
      CREATE POLICY tenant_isolation ON usage_events
      USING (tenant_id = current_tenant_id()) WITH CHECK (true)
    `)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY tenant_isolation ON usage_events`)
    await db.execute(sql`
      CREATE POLICY tenant_isolation ON usage_events
      USING (tenant_id = current_tenant_id())
    `)
  })

  it("guard REJECTS a leaked tenants policy", async () => {
    // `tenants` is keyed on `id`, not `tenant_id`, so it slipped past EVERY earlier
    // layer of defense. Leaking it means the entire customer list becomes readable
    // by any tenant.
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (true)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id())`)
  })

  it("guard REJECTS RLS that has been turned off", async () => {
    // Pins down the part of the guard that checks enabled+forced. In an earlier version
    // this lived in a separate block that no test called, so removing it left 44/44 green.
    await db.execute(sql`ALTER TABLE chunks DISABLE ROW LEVEL SECURITY`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`ALTER TABLE chunks ENABLE ROW LEVEL SECURITY`)
    await db.execute(sql`ALTER TABLE chunks FORCE ROW LEVEL SECURITY`)
  })

  it("guard REJECTS a new table without RLS", async () => {
    // Pins down the guard's ENUMERATION, not just its content. If the guard were
    // rewritten as a hardcoded list of table names, the other eight attack tests would
    // STILL be green — they all target already-listed tables. This test is the one that
    // catches that, and it also covers the most likely real-world scenario: the next
    // migration adds a table and forgets RLS.
    await db.execute(sql`CREATE TABLE forgot_rls (tenant_id uuid NOT NULL, content text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE forgot_rls`)
  })

  it("guard REJECTS a table in another schema without RLS", async () => {
    // An attack measured to leak both READ AND WRITE: `analytics.leads`.
    await db.execute(sql`CREATE SCHEMA analytics`)
    await db.execute(sql`CREATE TABLE analytics.leads (tenant_id uuid NOT NULL, notes text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP SCHEMA analytics CASCADE`)
  })

  it("guard REJECTS a partitioned table without RLS", async () => {
    // The parent of a partitioned table has relkind 'p', not 'r', so the old guard never
    // saw it and a `USING (true)` there would pass.
    await db.execute(sql`
      CREATE TABLE audit_log (tenant_id uuid NOT NULL, occurred_at timestamptz NOT NULL)
      PARTITION BY RANGE (occurred_at)
    `)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE audit_log`)
  })

  it("guard REJECTS a view readable by the app role without security_invoker", async () => {
    const guardView = guardBlock("guard_view")
    await db.execute(sql`CREATE VIEW summary AS SELECT tenant_id, visitor_id FROM conversations`)
    await db.execute(sql`GRANT SELECT ON summary TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).rejects.toThrow()
    // And with security_invoker on, the guard passes.
    await db.execute(sql`DROP VIEW summary`)
    await db.execute(sql`
      CREATE VIEW summary WITH (security_invoker = true) AS
      SELECT tenant_id, visitor_id FROM conversations
    `)
    await db.execute(sql`GRANT SELECT ON summary TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).resolves.toBeDefined()
    await db.execute(sql`DROP VIEW summary`)
  })

  it("guard REJECTS a SECURITY DEFINER function executable by the app role", async () => {
    const guardSecdef = guardBlock("guard_secdef")
    await db.execute(sql`
      CREATE FUNCTION leaky() RETURNS bigint LANGUAGE sql SECURITY DEFINER
      AS 'SELECT count(*) FROM conversations'
    `)
    await expect(db.execute(sql.raw(guardSecdef))).rejects.toThrow()
    await db.execute(sql`DROP FUNCTION leaky()`)
  })
})

/**
 * BEHAVIORAL tests, not text analysis.
 *
 * The guard in the migration checks the SHAPE of a policy. This file measures the
 * EFFECT: for EVERY table protected by RLS — enumerated via `relrowsecurity`, not via
 * the presence of a `tenant_id` column, so `tenants` is included too — the number of
 * rows a single tenant can see inside `withTenant` must equal the number of rows it
 * actually owns (the READ path), and any attempt to plant a row keyed to another
 * tenant must be rejected (the WRITE path).
 *
 * What's NOT covered: views, `SECURITY DEFINER` functions, and application code that
 * uses the raw handle (a connection that bypasses `withTenant`) are not checked here
 * at all. Coverage stops at RLS-protected tables accessed through `withTenant` — this
 * is not a blanket guarantee against every possible policy flaw everywhere.
 */
describe("isolation of every table, measured by behavior", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let idA: string
  let idB: string

  /** Populates ALL `tenant_id`-bearing tables for one tenant, respecting FK order. */
  async function seedEveryTable(tenantId: string, tag: string) {
    const one = async (q: ReturnType<typeof sql>) =>
      rowsOf(await db.execute(q))[0]!.id as string

    await db.execute(sql`INSERT INTO tenant_settings (tenant_id) VALUES (${tenantId})`)
    const userId = await one(sql`
      INSERT INTO admin_users (tenant_id, email, password_hash)
      VALUES (${tenantId}, ${`${tag}@example.com`}, 'x') RETURNING id
    `)
    await db.execute(sql`
      INSERT INTO admin_sessions (tenant_id, admin_user_id, expires_at)
      VALUES (${tenantId}, ${userId}, now() + interval '1 day')
    `)
    const sourceId = await one(sql`
      INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
      VALUES (${tenantId}, 'text', ${`${tag}.txt`}, 'ready') RETURNING id
    `)
    const skillId = await one(sql`
      INSERT INTO skills (tenant_id, name, is_fallback)
      VALUES (${tenantId}, ${`Skill ${tag}`}, true) RETURNING id
    `)
    await db.execute(sql`
      INSERT INTO skill_sources (tenant_id, skill_id, source_id)
      VALUES (${tenantId}, ${skillId}, ${sourceId})
    `)
    await db.execute(sql`
      INSERT INTO routing_rules (tenant_id, skill_id, position, kind)
      VALUES (${tenantId}, ${skillId}, 0, 'fallback')
    `)
    const docId = await one(sql`
      INSERT INTO documents (tenant_id, source_id, title)
      VALUES (${tenantId}, ${sourceId}, ${`Document ${tag}`}) RETURNING id
    `)
    const chunkId = await one(sql`
      INSERT INTO chunks (tenant_id, document_id, ordinal, content, embedding_model)
      VALUES (${tenantId}, ${docId}, 0, ${`content owned by ${tag}`}, 'test') RETURNING id
    `)
    const convId = await one(sql`
      INSERT INTO conversations (tenant_id, channel, visitor_id)
      VALUES (${tenantId}, 'widget', ${`v-${tag}`}) RETURNING id
    `)
    const msgId = await one(sql`
      INSERT INTO messages (tenant_id, conversation_id, role, content)
      VALUES (${tenantId}, ${convId}, 'assistant', ${`answer ${tag}`}) RETURNING id
    `)
    await db.execute(sql`
      INSERT INTO message_citations (tenant_id, message_id, chunk_id)
      VALUES (${tenantId}, ${msgId}, ${chunkId})
    `)
    await db.execute(sql`
      INSERT INTO escalations (tenant_id, conversation_id, reason)
      VALUES (${tenantId}, ${convId}, 'no_source')
    `)
    await db.execute(sql`
      INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, cost_cents)
      VALUES (${tenantId}, 'test', 10, 5, 1)
    `)
    await db.execute(sql`
      INSERT INTO canned_answers (tenant_id, question, answer, status)
      VALUES (${tenantId}, ${`what are the hours for ${tag}?`}, 'Nine to five.', 'approved')
    `)
  }

  beforeAll(async () => {
    db = await freshPglite()
    const r = await db.execute(sql`
      INSERT INTO tenants (slug, name) VALUES ('a', 'A'), ('b', 'B') RETURNING id
    `)
    const ids = rowsOf(r).map((x) => x.id as string)
    idA = ids[0]!
    idB = ids[1]!
    // BOTH tenants are populated. A single tenant would make every table "safe" only
    // vacuously: there's no one else's data that could leak, so nothing is proven.
    await seedEveryTable(ids[0]!, "a")
    await seedEveryTable(ids[1]!, "b")
  })

  /** All RLS-protected tables, along with each one's tenant key. */
  async function rlsTables(): Promise<{ name: string; key: string }[]> {
    const r = await db.execute(sql`
      SELECT c.relname AS name,
             CASE WHEN EXISTS (
               SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public' AND col.table_name = c.relname
                 AND col.column_name = 'tenant_id'
             ) THEN 'tenant_id' ELSE 'id' END AS key
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname
    `)
    return rowsOf(r).map((x) => ({ name: x.name as string, key: x.key as string }))
  }

  it("no underscore-prefixed table carries tenant data", async () => {
    // The guard exempts tables whose name starts with an underscore, because the
    // migration ledger must exist before the first migration runs and so cannot be
    // created by a migration the guard then inspects.
    //
    // That exemption is a rule, not a list of names — which means it could be abused to
    // hide a tenant-scoped table from every isolation check. This test closes that: an
    // infrastructure table holding a `tenant_id` fails here, so the only way to store
    // tenant data is under a name the guard actually examines.
    const smuggled = rowsOf(
      await db.execute(sql`
        SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND c.relkind IN ('r', 'p')
          AND c.relname LIKE '\\_%'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = n.nspname AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
          )
      `),
    ).map((r) => r.name as string)
    expect(smuggled).toEqual([])
  })

  it("every RLS-protected table only shows rows owned by that tenant", async () => {
    const tables = await rlsTables()
    const leaks: string[] = []
    const empty: string[] = []
    for (const { name, key } of tables) {
      const owned = Number(
        rowsOf(
          await db.execute(
            sql.raw(`SELECT count(*)::int AS n FROM ${name} WHERE ${key} = '${idA}'`),
          ),
        )[0]!.n,
      )
      const visible = await withTenant(db, idA, async (tx) =>
        Number(rowsOf(await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${name}`)))[0]!.n),
      )
      if (owned === 0) empty.push(name)
      if (visible !== owned) leaks.push(`${name}: visible ${visible}, owned ${owned}`)
      // Beyond the count, check that every visible tenant_id actually belongs to this
      // tenant. Comparing counts alone would let through the case where a tenant sees
      // exactly as many rows as it should, but they're rows belonging to ANOTHER tenant.
      if (key === "tenant_id") {
        const foreign = await withTenant(db, idA, async (tx) =>
          rowsOf(
            await tx.execute(sql.raw(`SELECT DISTINCT tenant_id::text AS t FROM ${name}`)),
          ).map((x) => x.t as string),
        )
        for (const t of foreign) if (t !== idA) leaks.push(`${name}: saw tenant_id ${t}`)
      }
    }
    expect(leaks).toEqual([])
    expect(empty).toEqual([])
    // A LOWER bound, not an exact number. Adding a table that's correctly protected by
    // RLS should NOT turn this test red; what should turn it red is a table that is NOT
    // protected — and that case doesn't even make it into this enumeration, so it's
    // caught by the "guard REJECTS a new table without RLS" test in the same file instead.
    expect(tables.length).toBeGreaterThanOrEqual(12)
    // Every table with a tenant_id column MUST have RLS. This is what catches a new
    // table that forgot protection, from the behavior side rather than the guard side.
    const withoutRls = rowsOf(
      await db.execute(sql`
        SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT c.relrowsecurity
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
          )
      `),
    ).map((x) => x.name as string)
    expect(withoutRls).toEqual([])
  })

  it("withTenant turns on iterative scan, because RLS filters after the index scan", async () => {
    // Without this, `ORDER BY embedding <=> v LIMIT k` can return fewer than k rows for
    // a small tenant in a large table — silent recall loss, no error at all.
    const value = await withTenant(db, idA, async (tx) => {
      const r = await tx.execute(sql`SHOW hnsw.iterative_scan`)
      return rowsOf(r)[0]!["hnsw.iterative_scan"] as string
    })
    expect(value).toBe("strict_order")
  })

  it("tenant cannot WRITE rows owned by another tenant", async () => {
    // The write path. Perfect read isolation is worthless if a tenant can still plant
    // rows in another tenant's data — and that's precisely the most damaging case:
    // fake business claims in someone else's transcript, or charges on someone else's
    // ledger.
    const failed: string[] = []
    const attempts: [string, ReturnType<typeof sql>][] = [
      ["usage_events", sql`
        INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, cost_cents)
        VALUES (${idB}, 'test', 1, 1, 500000)`],
      ["conversations", sql`
        INSERT INTO conversations (tenant_id, channel, visitor_id)
        VALUES (${idB}, 'widget', 'intruder')`],
      ["knowledge_sources", sql`
        INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
        VALUES (${idB}, 'text', 'intruder.txt', 'ready')`],
    ]
    for (const [name, statement] of attempts) {
      let rejected = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(statement)
        })
      } catch {
        rejected = true
      }
      if (!rejected) failed.push(name)
    }
    expect(failed).toEqual([])
  })

  it("tenant cannot UPDATE or DELETE another tenant's rows, nor MOVE its own row", async () => {
    // UPDATE on another tenant's rows must have NO effect (RLS hides them, so zero rows
    // affected), and moving one's OWN row to another tenant must be REJECTED by
    // with_check.
    const result = await withTenant(db, idA, async (tx) => {
      const upd = await tx.execute(sql.raw(
        `UPDATE conversations SET visitor_id = 'stolen' WHERE tenant_id = '${idB}'`,
      ))
      return rowsOf(upd).length
    })
    expect(result).toBe(0)

    // DELETE on another tenant's rows must behave the same: RLS hides them, so zero
    // rows are affected — not an error, and not the other tenant's rows disappearing.
    const deleteResult = await withTenant(db, idA, async (tx) => {
      const del = await tx.execute(sql.raw(`DELETE FROM conversations WHERE tenant_id = '${idB}'`))
      return rowsOf(del).length
    })
    expect(deleteResult).toBe(0)

    let moveRejected = false
    try {
      await withTenant(db, idA, async (tx) => {
        await tx.execute(sql.raw(`UPDATE conversations SET tenant_id = '${idB}'`))
      })
    } catch {
      moveRejected = true
    }
    expect(moveRejected).toBe(true)
  })

  it("app role cannot delete or update tenants rows", async () => {
    // DELETE would previously succeed and cascade-delete an entire tenant's own data.
    // UPDATE on slug would previously succeed, and the GLOBALLY unique slug index turns
    // it into a cross-tenant existence oracle.
    for (const statement of [
      sql`DELETE FROM tenants`,
      sql`UPDATE tenants SET slug = 'anything'`,
    ]) {
      let rejected = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(statement)
        })
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
    }
  })
})
