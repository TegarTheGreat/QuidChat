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
 *   1. The guard in the migration (the `guard_isolasi` block), which rejects
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
function blokGuard(nama: string): string {
  const migrasi = readFileSync(
    join(process.cwd(), "packages/db/migrations/0001_init.sql"),
    "utf8",
  )
  const buka = `DO $${nama}$`
  const tutup = `END $${nama}$;`
  const mulai = migrasi.indexOf(buka)
  if (mulai === -1) throw new Error(`blok ${buka} tidak ada di migrasi`)
  return migrasi.slice(mulai, migrasi.indexOf(tutup, mulai) + tutup.length)
}

describe("isolasi tenant di bawah serangan", () => {
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
    guard = blokGuard("guard_isolasi")
  })

  it("guard migrasi lolos pada skema yang sehat", async () => {
    await expect(db.execute(sql.raw(guard))).resolves.toBeDefined()
  })

  it("getTenantConfig bekerja normal pada skema yang sehat", async () => {
    const cfg = await createStore(db).getTenantConfig(tenantA)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
  })

  it("guard migrasi MENOLAK policy bocor yang ditambahkan berdampingan", async () => {
    await db.execute(sql`CREATE POLICY leak ON tenant_settings USING (true)`)
    // If this assertion fails, the guard has been weakened and an isolation leak
    // could land through a migration with nobody noticing.
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
  })

  it("getTenantConfig MELEMPAR alih-alih membaca setelan tenant lain", async () => {
    // The leaky policy from the previous test is still in place; that's exactly what's being tested.
    await expect(createStore(db).getTenantConfig(tenantA)).rejects.toThrow(
      "isolasi tenant gagal",
    )
    await db.execute(sql`DROP POLICY leak ON tenant_settings`)
  })

  it("guard migrasi MENOLAK policy yang hanya MENYEBUT current_tenant_id()", async () => {
    // The attack that defeated the second version of the guard. `USING (current_tenant_id()
    // IS NOT NULL)` mentions the function without restricting a single row, so a
    // "contains" check would pass while the table sits wide open. A substring check can
    // never prove a policy is actually restrictive — the guard now demands an EXACT
    // expression, and this test is what keeps it that way.
    await db.execute(
      sql`CREATE POLICY leak_menyebut ON conversations USING (current_tenant_id() IS NOT NULL)`,
    )
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY leak_menyebut ON conversations`)
  })

  it("guard MENOLAK with_check yang dibocorkan — jalur TULIS", async () => {
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

  it("guard MENOLAK policy tenants yang dibocorkan", async () => {
    // `tenants` is keyed on `id`, not `tenant_id`, so it slipped past EVERY earlier
    // layer of defense. Leaking it means the entire customer list becomes readable
    // by any tenant.
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (true)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id())`)
  })

  it("guard MENOLAK RLS yang dimatikan", async () => {
    // Pins down the part of the guard that checks enabled+forced. In an earlier version
    // this lived in a separate block that no test called, so removing it left 44/44 green.
    await db.execute(sql`ALTER TABLE chunks DISABLE ROW LEVEL SECURITY`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`ALTER TABLE chunks ENABLE ROW LEVEL SECURITY`)
    await db.execute(sql`ALTER TABLE chunks FORCE ROW LEVEL SECURITY`)
  })

  it("guard MENOLAK tabel baru tanpa RLS", async () => {
    // Pins down the guard's ENUMERATION, not just its content. If the guard were
    // rewritten as a hardcoded list of table names, the other eight attack tests would
    // STILL be green — they all target already-listed tables. This test is the one that
    // catches that, and it also covers the most likely real-world scenario: the next
    // migration adds a table and forgets RLS.
    await db.execute(sql`CREATE TABLE lupa_rls (tenant_id uuid NOT NULL, isi text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE lupa_rls`)
  })

  it("guard MENOLAK tabel di skema lain tanpa RLS", async () => {
    // An attack measured to leak both READ AND WRITE: `analytics.leads`.
    await db.execute(sql`CREATE SCHEMA analytics`)
    await db.execute(sql`CREATE TABLE analytics.leads (tenant_id uuid NOT NULL, catatan text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP SCHEMA analytics CASCADE`)
  })

  it("guard MENOLAK tabel terpartisi tanpa RLS", async () => {
    // The parent of a partitioned table has relkind 'p', not 'r', so the old guard never
    // saw it and a `USING (true)` there would pass.
    await db.execute(sql`
      CREATE TABLE audit_log (tenant_id uuid NOT NULL, saat timestamptz NOT NULL)
      PARTITION BY RANGE (saat)
    `)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE audit_log`)
  })

  it("guard MENOLAK view yang bisa dibaca app role tanpa security_invoker", async () => {
    const guardView = blokGuard("guard_view")
    await db.execute(sql`CREATE VIEW ringkasan AS SELECT tenant_id, visitor_id FROM conversations`)
    await db.execute(sql`GRANT SELECT ON ringkasan TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).rejects.toThrow()
    // And with security_invoker on, the guard passes.
    await db.execute(sql`DROP VIEW ringkasan`)
    await db.execute(sql`
      CREATE VIEW ringkasan WITH (security_invoker = true) AS
      SELECT tenant_id, visitor_id FROM conversations
    `)
    await db.execute(sql`GRANT SELECT ON ringkasan TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).resolves.toBeDefined()
    await db.execute(sql`DROP VIEW ringkasan`)
  })

  it("guard MENOLAK fungsi SECURITY DEFINER yang bisa dijalankan app role", async () => {
    const guardSecdef = blokGuard("guard_secdef")
    await db.execute(sql`
      CREATE FUNCTION bocor() RETURNS bigint LANGUAGE sql SECURITY DEFINER
      AS 'SELECT count(*) FROM conversations'
    `)
    await expect(db.execute(sql.raw(guardSecdef))).rejects.toThrow()
    await db.execute(sql`DROP FUNCTION bocor()`)
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
describe("isolasi setiap tabel, diukur dari perilakunya", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let idA: string
  let idB: string

  /** Populates ALL `tenant_id`-bearing tables for one tenant, respecting FK order. */
  async function isiPenuh(tenantId: string, tanda: string) {
    const satu = async (q: ReturnType<typeof sql>) =>
      rowsOf(await db.execute(q))[0]!.id as string

    await db.execute(sql`INSERT INTO tenant_settings (tenant_id) VALUES (${tenantId})`)
    const userId = await satu(sql`
      INSERT INTO admin_users (tenant_id, email, password_hash)
      VALUES (${tenantId}, ${`${tanda}@contoh.id`}, 'x') RETURNING id
    `)
    await db.execute(sql`
      INSERT INTO admin_sessions (tenant_id, admin_user_id, expires_at)
      VALUES (${tenantId}, ${userId}, now() + interval '1 day')
    `)
    const sourceId = await satu(sql`
      INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
      VALUES (${tenantId}, 'text', ${`${tanda}.txt`}, 'ready') RETURNING id
    `)
    const docId = await satu(sql`
      INSERT INTO documents (tenant_id, source_id, title)
      VALUES (${tenantId}, ${sourceId}, ${`Dokumen ${tanda}`}) RETURNING id
    `)
    const chunkId = await satu(sql`
      INSERT INTO chunks (tenant_id, document_id, ordinal, content, embedding_model)
      VALUES (${tenantId}, ${docId}, 0, ${`isi milik ${tanda}`}, 'test') RETURNING id
    `)
    const convId = await satu(sql`
      INSERT INTO conversations (tenant_id, channel, visitor_id)
      VALUES (${tenantId}, 'widget', ${`v-${tanda}`}) RETURNING id
    `)
    const msgId = await satu(sql`
      INSERT INTO messages (tenant_id, conversation_id, role, content)
      VALUES (${tenantId}, ${convId}, 'assistant', ${`jawaban ${tanda}`}) RETURNING id
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
    await isiPenuh(ids[0]!, "a")
    await isiPenuh(ids[1]!, "b")
  })

  /** All RLS-protected tables, along with each one's tenant key. */
  async function tabelBerRls(): Promise<{ nama: string; kunci: string }[]> {
    const r = await db.execute(sql`
      SELECT c.relname AS nama,
             CASE WHEN EXISTS (
               SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public' AND col.table_name = c.relname
                 AND col.column_name = 'tenant_id'
             ) THEN 'tenant_id' ELSE 'id' END AS kunci
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname
    `)
    return rowsOf(r).map((x) => ({ nama: x.nama as string, kunci: x.kunci as string }))
  }

  it("setiap tabel ber-RLS hanya memperlihatkan baris milik tenant itu", async () => {
    const tabel = await tabelBerRls()
    const bocor: string[] = []
    const hampa: string[] = []
    for (const { nama, kunci } of tabel) {
      const milik = Number(
        rowsOf(
          await db.execute(
            sql.raw(`SELECT count(*)::int AS n FROM ${nama} WHERE ${kunci} = '${idA}'`),
          ),
        )[0]!.n,
      )
      const terlihat = await withTenant(db, idA, async (tx) =>
        Number(rowsOf(await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${nama}`)))[0]!.n),
      )
      if (milik === 0) hampa.push(nama)
      if (terlihat !== milik) bocor.push(`${nama}: terlihat ${terlihat}, milik ${milik}`)
      // Beyond the count, check that every visible tenant_id actually belongs to this
      // tenant. Comparing counts alone would let through the case where a tenant sees
      // exactly as many rows as it should, but they're rows belonging to ANOTHER tenant.
      if (kunci === "tenant_id") {
        const asing = await withTenant(db, idA, async (tx) =>
          rowsOf(
            await tx.execute(sql.raw(`SELECT DISTINCT tenant_id::text AS t FROM ${nama}`)),
          ).map((x) => x.t as string),
        )
        for (const t of asing) if (t !== idA) bocor.push(`${nama}: melihat tenant_id ${t}`)
      }
    }
    expect(bocor).toEqual([])
    expect(hampa).toEqual([])
    // A LOWER bound, not an exact number. Adding a table that's correctly protected by
    // RLS should NOT turn this test red; what should turn it red is a table that is NOT
    // protected — and that case doesn't even make it into this enumeration, so it's
    // caught by the "guard MENOLAK tabel baru tanpa RLS" test in the same file instead.
    expect(tabel.length).toBeGreaterThanOrEqual(12)
    // Every table with a tenant_id column MUST have RLS. This is what catches a new
    // table that forgot protection, from the behavior side rather than the guard side.
    const tanpaRls = rowsOf(
      await db.execute(sql`
        SELECT c.relname AS nama
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT c.relrowsecurity
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
          )
      `),
    ).map((x) => x.nama as string)
    expect(tanpaRls).toEqual([])
  })

  it("withTenant menyalakan iterative scan, karena RLS menyaring setelah index scan", async () => {
    // Without this, `ORDER BY embedding <=> v LIMIT k` can return fewer than k rows for
    // a small tenant in a large table — silent recall loss, no error at all.
    const nilai = await withTenant(db, idA, async (tx) => {
      const r = await tx.execute(sql`SHOW hnsw.iterative_scan`)
      return rowsOf(r)[0]!["hnsw.iterative_scan"] as string
    })
    expect(nilai).toBe("strict_order")
  })

  it("tenant tidak bisa MENULIS baris milik tenant lain", async () => {
    // The write path. Perfect read isolation is worthless if a tenant can still plant
    // rows in another tenant's data — and that's precisely the most damaging case:
    // fake business claims in someone else's transcript, or charges on someone else's
    // ledger.
    const gagal: string[] = []
    const upaya: [string, ReturnType<typeof sql>][] = [
      ["usage_events", sql`
        INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, cost_cents)
        VALUES (${idB}, 'test', 1, 1, 500000)`],
      ["conversations", sql`
        INSERT INTO conversations (tenant_id, channel, visitor_id)
        VALUES (${idB}, 'widget', 'penyusup')`],
      ["knowledge_sources", sql`
        INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
        VALUES (${idB}, 'text', 'penyusup.txt', 'ready')`],
    ]
    for (const [nama, perintah] of upaya) {
      let ditolak = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(perintah)
        })
      } catch {
        ditolak = true
      }
      if (!ditolak) gagal.push(nama)
    }
    expect(gagal).toEqual([])
  })

  it("tenant tidak bisa MENGUBAH atau MENGHAPUS baris milik tenant lain, maupun MEMINDAHKAN baris sendiri", async () => {
    // UPDATE on another tenant's rows must have NO effect (RLS hides them, so zero rows
    // affected), and moving one's OWN row to another tenant must be REJECTED by
    // with_check.
    const hasil = await withTenant(db, idA, async (tx) => {
      const upd = await tx.execute(sql.raw(
        `UPDATE conversations SET visitor_id = 'dicuri' WHERE tenant_id = '${idB}'`,
      ))
      return rowsOf(upd).length
    })
    expect(hasil).toBe(0)

    // DELETE on another tenant's rows must behave the same: RLS hides them, so zero
    // rows are affected — not an error, and not the other tenant's rows disappearing.
    const hasilHapus = await withTenant(db, idA, async (tx) => {
      const del = await tx.execute(sql.raw(`DELETE FROM conversations WHERE tenant_id = '${idB}'`))
      return rowsOf(del).length
    })
    expect(hasilHapus).toBe(0)

    let pindahDitolak = false
    try {
      await withTenant(db, idA, async (tx) => {
        await tx.execute(sql.raw(`UPDATE conversations SET tenant_id = '${idB}'`))
      })
    } catch {
      pindahDitolak = true
    }
    expect(pindahDitolak).toBe(true)
  })

  it("app role tidak bisa menghapus atau mengubah baris tenants", async () => {
    // DELETE would previously succeed and cascade-delete an entire tenant's own data.
    // UPDATE on slug would previously succeed, and the GLOBALLY unique slug index turns
    // it into a cross-tenant existence oracle.
    for (const perintah of [
      sql`DELETE FROM tenants`,
      sql`UPDATE tenants SET slug = 'apa-pun'`,
    ]) {
      let ditolak = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(perintah)
        })
      } catch {
        ditolak = true
      }
      expect(ditolak).toBe(true)
    }
  })
})
