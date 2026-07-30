import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { createStore } from "./store.js"
import {
  chunks, conversations, documents, knowledgeSources, tenants, tenantSettings,
} from "./schema.js"
import { withTenant } from "./tenant.js"

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01)
}

async function seed(db: Awaited<ReturnType<typeof freshPglite>>) {
  const [t] = await db.insert(tenants).values({ slug: "toko", name: "Toko" }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "a.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Kebijakan" }).returning()
  const rows = await db.insert(chunks).values([
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: "Garansi resmi berlaku 12 bulan sejak pembelian.",
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: "Pengiriman ke Jawa memakan waktu 2 hari.",
      embedding: fakeEmbedding(2), embeddingModel: "test" },
  ]).returning()
  const [cv] = await db.insert(conversations)
    .values({ tenantId: t!.id, channel: "widget", visitorId: "v1" }).returning()
  return { tenantId: t!.id, chunkId: rows[0]!.id, conversationId: cv!.id }
}

// SATU database dipakai bersama oleh seluruh test di file ini, lewat `beforeAll`.
// Dua alasan:
//   1. `freshPglite()` membangun Postgres WASM lengkap dan menerapkan migrasi —
//      sekitar 7 detik dan beberapa ratus MB per instance. EMPAT instance dalam
//      satu file membuat worker vitest mati dengan "Worker exited unexpectedly".
//      Itu terukur, bukan dugaan.
//   2. Test di bawah ini aman berbagi: tiga yang pertama hanya membaca, dan yang
//      terakhir hanya menulis ke `messages`, `message_citations`, dan
//      `escalations` — tabel yang tidak dibaca test lain. Kalau nanti ada test
//      yang membaca tabel tulis itu, urutan test mulai berpengaruh dan file ini
//      harus dipecah, bukan ditambahi.
describe("createStore", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let ids: Awaited<ReturnType<typeof seed>>

  beforeAll(async () => {
    db = await freshPglite()
    ids = await seed(db)
  })

  it("mengembalikan konfigurasi tenant", async () => {
    const cfg = await createStore(db).getTenantConfig(ids.tenantId)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.highRiskTopics).toContain("garansi")
  })

  it("menemukan chunk lewat kata kunci", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: ids.tenantId, query: "garansi", embedding: fakeEmbedding(1), limit: 5,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain("Garansi")
    expect(hits[0]!.documentTitle).toBe("Kebijakan")
  })

  it("tidak mengembalikan apa pun untuk tenant lain", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: "00000000-0000-0000-0000-000000000000",
      query: "garansi", embedding: fakeEmbedding(1), limit: 5,
    })
    expect(hits).toEqual([])
  })

  it("menyimpan jawaban beserta sitasinya, dan menyimpan eskalasi", async () => {
    const store = createStore(db)
    await store.recordAnswer({
      tenantId: ids.tenantId,
      conversationId: ids.conversationId,
      segments: [
        { kind: "general", text: "Halo!" },
        { kind: "business_claim", text: "Garansi 12 bulan.", citations: [ids.chunkId] },
      ],
      citedChunkIds: [ids.chunkId],
    })
    await store.recordEscalation({
      tenantId: ids.tenantId,
      conversationId: ids.conversationId,
      reason: "no_source",
    })

    const counts = await withTenant(db, ids.tenantId, async (tx) => {
      const res = await tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM messages)          AS messages,
          (SELECT count(*)::int FROM message_citations) AS citations,
          (SELECT count(*)::int FROM escalations)       AS escalations
      `)
      return (Array.isArray(res) ? res : (res as { rows: Record<string, unknown>[] }).rows)[0]!
    })

    expect(counts.messages).toBe(1)
    expect(counts.citations).toBe(1)
    expect(counts.escalations).toBe(1)
  })
})
