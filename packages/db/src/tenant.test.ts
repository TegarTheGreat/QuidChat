import { describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { withTenant } from "./tenant.js"
import { chunks, documents, knowledgeSources, tenants } from "./schema.js"

async function seedTenant(db: Awaited<ReturnType<typeof freshPglite>>, slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: slug }).returning()
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: `${slug}.txt`, status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: `${slug} doc` }).returning()
  await db.insert(chunks).values({
    tenantId: t!.id, documentId: d!.id, ordinal: 0,
    content: `rahasia milik ${slug}`, embeddingModel: "test",
  })
  return t!.id
}

describe("isolasi tenant", () => {
  it("tenant hanya melihat chunk miliknya sendiri", async () => {
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

  it("tanpa konteks tenant mengembalikan nol baris, bukan semuanya", async () => {
    const db = await freshPglite()
    await seedTenant(db, "tenant-a")
    await seedTenant(db, "tenant-b")

    const rows = await withTenant(db, "00000000-0000-0000-0000-000000000000",
      (tx) => tx.select().from(chunks))
    expect(rows).toHaveLength(0)
  })
})
