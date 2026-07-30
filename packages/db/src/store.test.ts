import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { createStore } from "./store.js"
import {
  chunks, conversations, documents, knowledgeSources, tenants, tenantSettings,
} from "./schema.js"
import { withTenant } from "./tenant.js"

// Parameter is `offset`, not `seed` — the name `seed` is already used by the
// seeding function below, and shadowing it makes lint complain and readers unsure.
function fakeEmbedding(offset: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(offset + i) * 0.01)
}

/**
 * Sets up one complete tenant: settings, source, document, two chunks, and one
 * conversation. `garansiText` is made different per tenant so isolation tests can
 * prove WHICH tenant's data is visible — not just that the result is empty.
 */
async function seed(
  db: Awaited<ReturnType<typeof freshPglite>>,
  slug: string,
  garansiText: string,
) {
  const [t] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "a.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Kebijakan" }).returning()
  const rows = await db.insert(chunks).values([
    // Contains the keyword, embedding FAR from the test query.
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: garansiText,
      embedding: fakeEmbedding(50), embeddingModel: "test" },
    // Does NOT contain the keyword, embedding IDENTICAL to the test query.
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: SEM_ONLY,
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    // Identical embedding BUT a different model -> must be filtered out of the vector path.
    { tenantId: t!.id, documentId: d!.id, ordinal: 2,
      content: MODEL_LAIN,
      embedding: fakeEmbedding(1), embeddingModel: "model-lain" },
  ]).returning()
  const [cv] = await db.insert(conversations)
    .values({ tenantId: t!.id, channel: "widget", visitorId: "v1" }).returning()
  return { tenantId: t!.id, chunkId: rows[0]!.id, conversationId: cv!.id }
}

const GARANSI_TOKO = "Garansi resmi berlaku 12 bulan sejak pembelian."
const GARANSI_WARUNG = "Garansi warung hanya 3 bulan."
const SEM_ONLY = "Pengiriman ke Jawa memakan waktu dua hari kerja."
const MODEL_LAIN = "Garansi lama: ini di-embed dengan model lain."
const TANPA_EMBEDDING = "Kebijakan pengembalian barang berlaku tujuh hari."

/**
 * Explicit chunk IDs, instead of the default `defaultRandom()`. The scenarios below
 * need deterministic RANK ordering among rows that are DELIBERATELY built with the
 * same ts_rank (one keyword occurrence) and/or the same cosine distance — and
 * `ORDER BY ..., c.id` in `store.ts` uses id as the tiebreaker. With random ids, who
 * wins the tie changes on every test run, making tests that depend on it flaky.
 */
function fixedId(kategori: string, n: number): string {
  return `00000000-0000-4000-8000-${kategori}${String(n).padStart(8, "0")}`
}

/**
 * The "12 irrelevant chunks" scenario from the calculation in `store.ts`, made REAL
 * through a fixture instead of staying just a comment. Kept in a tenant separate from
 * `toko`/`warung` so its ~28 chunk rows don't change what other tests see.
 *
 * - `TANPA_EMBEDDING`: one keyword occurrence, smallest id -> guaranteed keyword rank
 *   #1 (wins the tie via id, not via text relevance — ts_rank is PROVEN identical for
 *   one occurrence regardless of document length).
 * - 12 "keyword-only" chunks: contain the keyword, WITHOUT an embedding. Fill keyword
 *   ranks #2-13. Permanently single-list, so they can NEVER beat `TANPA_EMBEDDING` at
 *   any k — its safety is independent of k.
 * - 12 "vector-only" chunks: embedding CLOSE to the query vector, do NOT contain the
 *   keyword. Fill vector ranks #1-12. Also single-list, equally safe.
 * - 3 "irrelevant chunks": LIKE `TANPA_EMBEDDING`, they CONTAIN the keyword (one
 *   occurrence, same ts_rank) AND have an embedding — so they're DUAL-list, with
 *   keyword ranks #14-16 and vector ranks #13-15 (behind the 24 single-list chunks
 *   above). These are the "shipping note number 2" chunks referenced in the constant's
 *   rationale: their relevance is poor on BOTH paths, but the dual presence alone is
 *   enough to beat `TANPA_EMBEDDING` at k=60 (combined score ~0.0268 vs 0.0164) and
 *   NOT enough at k=10 (~0.0851 vs 0.0909) — exactly the reversal this fix is meant
 *   to produce.
 */
async function seedRrfGap(db: Awaited<ReturnType<typeof freshPglite>>) {
  const [t] = await db.insert(tenants).values({ slug: "gudang", name: "gudang" }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "b.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Gudang" }).returning()

  const rows: (typeof chunks.$inferInsert)[] = [
    { id: fixedId("0000", 0), tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: TANPA_EMBEDDING, embedding: null, embeddingModel: "test" },
  ]
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: fixedId("1111", i), tenantId: t!.id, documentId: d!.id, ordinal: 10 + i,
      content: `Catatan pengembalian barang nomor ${i}, hanya kata kunci, tanpa embedding.`,
      embedding: null, embeddingModel: "test",
    })
  }
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: fixedId("2222", i), tenantId: t!.id, documentId: d!.id, ordinal: 40 + i,
      content: `Catatan pengiriman tidak terkait sama sekali nomor ${i}.`,
      embedding: fakeEmbedding(600 + i * 0.01), embeddingModel: "test",
    })
  }
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: fixedId("9999", i), tenantId: t!.id, documentId: d!.id, ordinal: 90 + i,
      content: `Catatan operasional nomor ${i} tentang pengiriman, sedikit menyinggung `
        + "pengembalian barang di sela-sela laporan.",
      embedding: fakeEmbedding(700 + i * 0.01), embeddingModel: "test",
    })
  }
  await db.insert(chunks).values(rows)
  return { tenantId: t!.id }
}

// ONE database is shared by every test in this file, via `beforeAll`.
// Two reasons:
//   1. `freshPglite()` builds a full WASM Postgres and applies migrations —
//      about 7 seconds and several hundred MB per instance. FOUR instances in
//      one file kills the vitest worker with "Worker exited unexpectedly".
//      That's measured, not a guess.
//   2. The tests below are safe to share: the first three only read, and the
//      last one only writes to `messages`, `message_citations`, and
//      `escalations` — tables no other test reads. If a future test reads
//      those written-to tables, test order starts to matter and this file
//      should be split, not added to.
describe("createStore", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let toko: Awaited<ReturnType<typeof seed>>
  let warung: Awaited<ReturnType<typeof seed>>
  let gudang: Awaited<ReturnType<typeof seedRrfGap>>

  beforeAll(async () => {
    db = await freshPglite()
    toko = await seed(db, "toko", GARANSI_TOKO)
    warung = await seed(db, "warung", GARANSI_WARUNG)
    gudang = await seedRrfGap(db)
  })

  it("mengembalikan konfigurasi tenant", async () => {
    const cfg = await createStore(db).getTenantConfig(toko.tenantId)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
    expect(cfg.highRiskTopics).toContain("garansi")
  })

  it("menemukan chunk lewat kata kunci", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 5,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toBe(GARANSI_TOKO)
    expect(hits[0]!.documentTitle).toBe("Kebijakan")
  })

  it("jalur kata kunci hidup: chunk ber-kata-kunci menang walau embedding-nya jauh", async () => {
    // The query embedding is deliberately far from EVERY chunk, so the only reason a
    // chunk can win is the keyword path. If the ts_rank term were removed from the
    // implementation, this test would fail — which did not happen with an earlier version.
    //
    // Offset 600, not 999: `fakeEmbedding` is based on sin(offset+i), so it's periodic.
    // Verified by manual cosine calculation that 600 makes the semantic path ALONE win
    // SEM_ONLY (not GARANSI_TOKO) — so without the keyword path, this test genuinely
    // fails, rather than happening to pass anyway.
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(GARANSI_TOKO)
  })

  it("jalur semantik hidup: tanpa kecocokan kata kunci, yang terdekat tetap ditemukan", async () => {
    // A query that matches no keyword at all. If the cosine term were removed, the
    // keyword path would return nothing and this test would fail.
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "zzz tidak ada di mana pun",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(SEM_ONLY)
  })

  it("jalur vektor hanya mempertimbangkan model embedding yang diminta", async () => {
    // The `embedding_model` filter lives in the `sem` CTE ONLY, and that's correct: a
    // chunk's text content doesn't depend on its embedding model, so the keyword path
    // is right to cover every chunk. What's being guarded is that the vector space
    // isn't mixed.
    //
    // The fixture deliberately CONTAINS the keyword "garansi". An earlier version did
    // not, and because of that the test passed without proving anything about the filter.
    const lewatKataKunci = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 10,
    })
    // Through the keyword path it's SUPPOSED to appear — that's valid.
    expect(lewatKataKunci.map((h) => h.content)).toContain(MODEL_LAIN)

    // But through the vector path it must NOT: a query that matches no keyword at all,
    // with an embedding identical to that chunk, still must not return it.
    const lewatVektor = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "zzz tidak ada di mana pun",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 10,
    })
    expect(lewatVektor.map((h) => h.content)).not.toContain(MODEL_LAIN)
  })

  it("chunk ber-kata-kunci tanpa embedding tetap bisa ditemukan di antara chunk tak relevan", async () => {
    // A real-world case: a new document is uploaded, its embedding hasn't finished
    // generating yet, and then a customer asks a question. The fixture (see
    // `seedRrfGap`) builds exactly the scenario measured in the RRF constant's
    // rationale: `TANPA_EMBEDDING` competes against 24 single-list chunks (safe at any
    // k) AND 3 dual-list chunks whose text relevance is poor but whose dual presence,
    // at k=60, is still enough to beat it.
    //
    // The query "pengembalian barang" is deliberately 2 words, not "garansi": with the
    // old 4-chunk fixture, the one chunk that matched this query's keyword ALWAYS made
    // it into `limit`, regardless of the constant — that test passed without proving
    // anything. Verified via repeated `pnpm vitest` runs that this result is stable,
    // not a lucky id tiebreak (see `fixedId`).
    const hits = await createStore(db).searchChunks({
      tenantId: gudang.tenantId, query: "pengembalian barang",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 3,
    })
    expect(hits.map((h) => h.content)).toContain(TANPA_EMBEDDING)
  })

  it("setiap tenant hanya melihat chunk miliknya sendiri", async () => {
    // TWO real tenants, each with distinguishable chunks.
    // Querying a random uuid with no data only proves "empty", and that doesn't
    // distinguish "RLS is filtering" from "this tenant simply has nothing". Here both
    // tenants have content, so if RLS leaks, this test fails.
    const store = createStore(db)
    const args = { query: "garansi", embedding: fakeEmbedding(1), embeddingModel: "test", limit: 5 }

    const isiToko = (await store.searchChunks({ tenantId: toko.tenantId, ...args }))
      .map((h) => h.content)
    const isiWarung = (await store.searchChunks({ tenantId: warung.tenantId, ...args }))
      .map((h) => h.content)

    expect(isiToko).toContain(GARANSI_TOKO)
    expect(isiToko).not.toContain(GARANSI_WARUNG)
    expect(isiWarung).toContain(GARANSI_WARUNG)
    expect(isiWarung).not.toContain(GARANSI_TOKO)

    // A tenant that doesn't exist at all must still come back empty.
    const isiAsing = await store.searchChunks({
      tenantId: "00000000-0000-0000-0000-000000000000", ...args,
    })
    expect(isiAsing).toEqual([])
  })

  it("menyimpan jawaban beserta sitasinya, dan menyimpan eskalasi", async () => {
    const store = createStore(db)
    await store.recordUserTurn({
      tenantId: toko.tenantId,
      conversationId: toko.conversationId,
      text: "garansi berapa lama?",
    })
    await store.recordAnswer({
      tenantId: toko.tenantId,
      conversationId: toko.conversationId,
      segments: [
        { kind: "general", text: "Halo!" },
        { kind: "business_claim", text: "Garansi 12 bulan.", citations: [toko.chunkId] },
      ],
      citedChunkIds: [toko.chunkId],
    })
    await store.recordEscalation({
      tenantId: toko.tenantId,
      conversationId: toko.conversationId,
      reason: "no_source",
    })

    const counts = await withTenant(db, toko.tenantId, async (tx) => {
      const res = await tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM messages)          AS messages,
          (SELECT count(*)::int FROM message_citations) AS citations,
          (SELECT count(*)::int FROM escalations)       AS escalations
      `)
      return (Array.isArray(res) ? res : (res as { rows: Record<string, unknown>[] }).rows)[0]!
    })

    expect(counts.messages).toBe(2)
    expect(counts.citations).toBe(1)
    expect(counts.escalations).toBe(1)
  })
})
