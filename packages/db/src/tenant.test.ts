import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { withTenant } from "./tenant.js"
import { chunks, documents, knowledgeSources, tenants } from "./schema.js"

/** Normalizes the `execute()` result: the PGlite driver returns `{rows}`, postgres-js an Array. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

async function seedTenant(db: Awaited<ReturnType<typeof freshPglite>>, slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: slug }).returning()
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: `${slug}.txt`, status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: `${slug} doc` }).returning()
  await db.insert(chunks).values({
    tenantId: t!.id, documentId: d!.id, ordinal: 0,
    content: `secret belonging to ${slug}`, embeddingModel: "test",
  })
  return t!.id
}

describe("tenant isolation", () => {
  it("a tenant only sees its own chunks", async () => {
    const db = await freshPglite()
    const a = await seedTenant(db, "tenant-a")
    const b = await seedTenant(db, "tenant-b")

    const rowsA = await withTenant(db, a, (tx) => tx.select().from(chunks))
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0]!.tenantId).toBe(a)
    expect(rowsA[0]!.content).toContain("tenant-a")

    const rowsB = await withTenant(db, b, (tx) => tx.select().from(chunks))
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0]!.tenantId).toBe(b)
  })

  // An unknown tenant id is equivalent to having no context at all under
  // Postgres's NULL semantics: current_tenant_id() equally fails to match any
  // tenant_id, so both end up as zero rows.
  it("an unknown tenant id returns zero rows, not every row", async () => {
    const db = await freshPglite()
    await seedTenant(db, "tenant-a")
    await seedTenant(db, "tenant-b")

    const rows = await withTenant(db, "00000000-0000-0000-0000-000000000000",
      (tx) => tx.select().from(chunks))
    expect(rows).toHaveLength(0)
  })

  it("the raw handle BYPASSES RLS — this is why withTenant must be used", async () => {
    const db = await freshPglite()
    const a = await seedTenant(db, "tenant-a")
    await seedTenant(db, "tenant-b")

    // Without withTenant: the default connection is superuser, and superuser bypasses
    // RLS entirely — including FORCE ROW LEVEL SECURITY. So this query sees EVERY
    // tenant. This isn't a bug waiting to be fixed; it's exactly why every query
    // against a tenant-scoped table MUST go through withTenant.
    const raw = await db.select().from(chunks)
    expect(raw).toHaveLength(2)

    // Through withTenant, the same tenant only sees its own.
    const scoped = await withTenant(db, a, (tx) => tx.select().from(chunks))
    expect(scoped).toHaveLength(1)
  })

  it("tenant context does not persist after the transaction ends", async () => {
    const db = await freshPglite()
    const r = await db.execute(sql`INSERT INTO tenants (slug, name) VALUES ('a','A') RETURNING id`)
    const id = rowsOf(r)[0]!.id as string

    await withTenant(db, id, async (tx) => {
      const inside = rowsOf(await tx.execute(sql`SELECT current_tenant_id() AS t`))[0]!.t
      expect(inside).toBe(id)
    })

    // OUTSIDE the transaction, the context must be gone. If `set_config` were called with
    // `false`, the value would be session-scoped and persist — and on a pooled connection
    // that would mean the next request inherits the previous request's tenant.
    const outside = rowsOf(await db.execute(sql`SELECT current_tenant_id() AS t`))[0]!.t
    expect(outside).toBeNull()
  })
})
