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
 * conversation. `warrantyText` is made different per tenant so isolation tests can
 * prove WHICH tenant's data is visible — not just that the result is empty.
 */
async function seed(
  db: Awaited<ReturnType<typeof freshPglite>>,
  slug: string,
  warrantyText: string,
) {
  const [t] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "a.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Policy" }).returning()
  const rows = await db.insert(chunks).values([
    // Contains the keyword, embedding FAR from the test query.
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: warrantyText,
      embedding: fakeEmbedding(50), embeddingModel: "test" },
    // Does NOT contain the keyword, embedding IDENTICAL to the test query.
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: SEMANTIC_ONLY,
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    // Identical embedding BUT a different model -> must be filtered out of the vector path.
    { tenantId: t!.id, documentId: d!.id, ordinal: 2,
      content: OTHER_MODEL,
      embedding: fakeEmbedding(1), embeddingModel: "other-model" },
  ]).returning()
  const [cv] = await db.insert(conversations)
    .values({ tenantId: t!.id, channel: "widget", visitorId: "v1" }).returning()
  return { tenantId: t!.id, chunkId: rows[0]!.id, conversationId: cv!.id }
}

const WARRANTY_SHOP = "Official warranty valid for 12 months from purchase."
const WARRANTY_STALL = "Stall warranty is only 3 months."
const SEMANTIC_ONLY = "Shipping to Java takes two business days."
const OTHER_MODEL = "Old warranty: this was embedded with a different model."
const NO_EMBEDDING = "Return goods policy applies for seven days."

/**
 * Explicit chunk IDs, instead of the default `defaultRandom()`. The scenarios below
 * need deterministic RANK ordering among rows that are DELIBERATELY built with the
 * same ts_rank (one keyword occurrence) and/or the same cosine distance — and
 * `ORDER BY ..., c.id` in `store.ts` uses id as the tiebreaker. With random ids, who
 * wins the tie changes on every test run, making tests that depend on it flaky.
 */
function fixedId(category: string, n: number): string {
  return `00000000-0000-4000-8000-${category}${String(n).padStart(8, "0")}`
}

/**
 * The "12 irrelevant chunks" scenario from the calculation in `store.ts`, made REAL
 * through a fixture instead of staying just a comment. Kept in a tenant separate from
 * `shop`/`stall` so its ~28 chunk rows don't change what other tests see.
 *
 * - `NO_EMBEDDING`: one keyword occurrence, smallest id -> guaranteed keyword rank
 *   #1 (wins the tie via id, not via text relevance — ts_rank is PROVEN identical for
 *   one occurrence regardless of document length).
 * - 12 "keyword-only" chunks: contain the keyword, WITHOUT an embedding. Fill keyword
 *   ranks #2-13. Permanently single-list, so they can NEVER beat `NO_EMBEDDING` at
 *   any k — its safety is independent of k.
 * - 12 "vector-only" chunks: embedding CLOSE to the query vector, do NOT contain the
 *   keyword. Fill vector ranks #1-12. Also single-list, equally safe.
 * - 3 "irrelevant chunks": LIKE `NO_EMBEDDING`, they CONTAIN the keyword (one
 *   occurrence, same ts_rank) AND have an embedding — so they're DUAL-list, with
 *   keyword ranks #14-16 and vector ranks #13-15 (behind the 24 single-list chunks
 *   above). These are the "shipping note number 2" chunks referenced in the constant's
 *   rationale: their relevance is poor on BOTH paths, but the dual presence alone is
 *   enough to beat `NO_EMBEDDING` at k=60 (combined score ~0.0268 vs 0.0164) and
 *   NOT enough at k=10 (~0.0851 vs 0.0909) — exactly the reversal this fix is meant
 *   to produce.
 */
async function seedRrfGap(db: Awaited<ReturnType<typeof freshPglite>>) {
  const [t] = await db.insert(tenants).values({ slug: "warehouse", name: "warehouse" }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "b.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Warehouse" }).returning()

  const rows: (typeof chunks.$inferInsert)[] = [
    { id: fixedId("0000", 0), tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: NO_EMBEDDING, embedding: null, embeddingModel: "test" },
  ]
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: fixedId("1111", i), tenantId: t!.id, documentId: d!.id, ordinal: 10 + i,
      content: `Return goods note number ${i}, keyword only, no embedding.`,
      embedding: null, embeddingModel: "test",
    })
  }
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: fixedId("2222", i), tenantId: t!.id, documentId: d!.id, ordinal: 40 + i,
      content: `Shipping note, completely unrelated, number ${i}.`,
      embedding: fakeEmbedding(600 + i * 0.01), embeddingModel: "test",
    })
  }
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: fixedId("9999", i), tenantId: t!.id, documentId: d!.id, ordinal: 90 + i,
      content: `Operational note number ${i} about shipping, briefly mentioning `
        + "return goods in the middle of the report.",
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
  let shop: Awaited<ReturnType<typeof seed>>
  let stall: Awaited<ReturnType<typeof seed>>
  let warehouse: Awaited<ReturnType<typeof seedRrfGap>>

  beforeAll(async () => {
    db = await freshPglite()
    shop = await seed(db, "shop", WARRANTY_SHOP)
    stall = await seed(db, "stall", WARRANTY_STALL)
    warehouse = await seedRrfGap(db)
  })

  it("returns the tenant configuration", async () => {
    const cfg = await createStore(db).getTenantConfig(shop.tenantId)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
    expect(cfg.highRiskTopics).toContain("warranty")
  })

  it("finds a chunk via the keyword path", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "warranty",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 5,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toBe(WARRANTY_SHOP)
    expect(hits[0]!.documentTitle).toBe("Policy")
  })

  it("keyword path works: a chunk containing the keyword wins even with a distant embedding", async () => {
    // The query embedding is deliberately far from EVERY chunk, so the only reason a
    // chunk can win is the keyword path. If the ts_rank term were removed from the
    // implementation, this test would fail — which did not happen with an earlier version.
    //
    // Offset 600, not 999: `fakeEmbedding` is based on sin(offset+i), so it's periodic.
    // Verified by manual cosine calculation that 600 makes the semantic path ALONE win
    // SEMANTIC_ONLY (not WARRANTY_SHOP) — so without the keyword path, this test genuinely
    // fails, rather than happening to pass anyway.
    const hits = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "warranty",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(WARRANTY_SHOP)
  })

  it("semantic path works: with no keyword match, the closest chunk is still found", async () => {
    // A query that matches no keyword at all. If the cosine term were removed, the
    // keyword path would return nothing and this test would fail.
    const hits = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "zzz not found anywhere",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(SEMANTIC_ONLY)
  })

  it("the vector path only considers the requested embedding model", async () => {
    // The `embedding_model` filter lives in the `sem` CTE ONLY, and that's correct: a
    // chunk's text content doesn't depend on its embedding model, so the keyword path
    // is right to cover every chunk. What's being guarded is that the vector space
    // isn't mixed.
    //
    // The fixture deliberately CONTAINS the keyword "warranty". An earlier version did
    // not, and because of that the test passed without proving anything about the filter.
    const viaKeyword = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "warranty",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 10,
    })
    // Through the keyword path it's SUPPOSED to appear — that's valid.
    expect(viaKeyword.map((h) => h.content)).toContain(OTHER_MODEL)

    // But through the vector path it must NOT: a query that matches no keyword at all,
    // with an embedding identical to that chunk, still must not return it.
    const viaVector = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "zzz not found anywhere",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 10,
    })
    expect(viaVector.map((h) => h.content)).not.toContain(OTHER_MODEL)
  })

  it("a keyword chunk without an embedding can still be found among irrelevant chunks", async () => {
    // A real-world case: a new document is uploaded, its embedding hasn't finished
    // generating yet, and then a customer asks a question. The fixture (see
    // `seedRrfGap`) builds exactly the scenario measured in the RRF constant's
    // rationale: `NO_EMBEDDING` competes against 24 single-list chunks (safe at any
    // k) AND 3 dual-list chunks whose text relevance is poor but whose dual presence,
    // at k=60, is still enough to beat it.
    //
    // The query "return goods" is deliberately 2 words, not "warranty": with the
    // old 4-chunk fixture, the one chunk that matched this query's keyword ALWAYS made
    // it into `limit`, regardless of the constant — that test passed without proving
    // anything. Verified via repeated `pnpm vitest` runs that this result is stable,
    // not a lucky id tiebreak (see `fixedId`).
    const hits = await createStore(db).searchChunks({
      tenantId: warehouse.tenantId, query: "return goods",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 3,
    })
    expect(hits.map((h) => h.content)).toContain(NO_EMBEDDING)
  })

  it("each tenant only sees its own chunks", async () => {
    // TWO real tenants, each with distinguishable chunks.
    // Querying a random uuid with no data only proves "empty", and that doesn't
    // distinguish "RLS is filtering" from "this tenant simply has nothing". Here both
    // tenants have content, so if RLS leaks, this test fails.
    const store = createStore(db)
    const args = { query: "warranty", embedding: fakeEmbedding(1), embeddingModel: "test", limit: 5 }

    const shopRows = (await store.searchChunks({ tenantId: shop.tenantId, ...args }))
      .map((h) => h.content)
    const stallRows = (await store.searchChunks({ tenantId: stall.tenantId, ...args }))
      .map((h) => h.content)

    expect(shopRows).toContain(WARRANTY_SHOP)
    expect(shopRows).not.toContain(WARRANTY_STALL)
    expect(stallRows).toContain(WARRANTY_STALL)
    expect(stallRows).not.toContain(WARRANTY_SHOP)

    // A tenant that doesn't exist at all must still come back empty.
    const foreignRows = await store.searchChunks({
      tenantId: "00000000-0000-0000-0000-000000000000", ...args,
    })
    expect(foreignRows).toEqual([])
  })

  it("stores an answer along with its citations, and stores an escalation", async () => {
    const store = createStore(db)
    await store.recordUserTurn({
      tenantId: shop.tenantId,
      conversationId: shop.conversationId,
      text: "how long is the warranty?",
    })
    await store.recordAnswer({
      tenantId: shop.tenantId,
      conversationId: shop.conversationId,
      segments: [
        { kind: "general", text: "Hello!" },
        { kind: "business_claim", text: "Warranty: 12 months.", citations: [shop.chunkId] },
      ],
      citedChunkIds: [shop.chunkId],
    })
    await store.recordEscalation({
      tenantId: shop.tenantId,
      conversationId: shop.conversationId,
      reason: "no_source",
    })

    const counts = await withTenant(db, shop.tenantId, async (tx) => {
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

  describe("a question asked the way a customer asks it", () => {
    it("still reaches the document, instead of losing the keyword arm entirely", async () => {
      // `plainto_tsquery` ANDs every token, so "how long is the warranty?" became
      // `'how' & 'long' & 'is' & 'the' & 'warranty'` and required a chunk to contain all five. A
      // policy saying "Official warranty 12 months" matched none of it. The keyword arm returned
      // nothing for any question phrased as a sentence — which is how every customer asks one —
      // and hybrid search quietly became vector-only.
      const [t] = await db.insert(tenants).values({ slug: "fts", name: "fts" }).returning()
      await db.insert(tenantSettings).values({ tenantId: t!.id })
      const [s] = await db.insert(knowledgeSources)
        .values({ tenantId: t!.id, kind: "text", uri: "a.txt", status: "ready" }).returning()
      const [d] = await db.insert(documents)
        .values({ tenantId: t!.id, sourceId: s!.id, title: "Policy" }).returning()
      await db.insert(chunks).values([
        // Matches the question's words, embedding FAR from it — the same shape as the tests
        // above, so the keyword arm is the only thing that can lift it.
        { tenantId: t!.id, documentId: d!.id, ordinal: 0,
          content: "Official warranty 12 months from the purchase date.",
          embedding: fakeEmbedding(90), embeddingModel: "test" },
        // Shares NOT ONE word with the question, embedding IDENTICAL to it. Without a working
        // keyword arm this is the only chunk retrieval can rank, and it wins.
        { tenantId: t!.id, documentId: d!.id, ordinal: 1,
          content: "Kami buka pukul sembilan pagi sampai lima sore.",
          embedding: fakeEmbedding(1), embeddingModel: "test" },
      ])

      const store = createStore(db)
      const hits = await store.searchChunks({
        tenantId: t!.id,
        query: "how long is the warranty?",
        embedding: fakeEmbedding(1),
        embeddingModel: "test",
        limit: 2,
      })

      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]!.content).toContain("warranty")
    })

    it("still ranks a bare keyword the same way", async () => {
      const [t] = await db.insert(tenants).values({ slug: "fts2", name: "fts2" }).returning()
      await db.insert(tenantSettings).values({ tenantId: t!.id })
      const [s] = await db.insert(knowledgeSources)
        .values({ tenantId: t!.id, kind: "text", uri: "a.txt", status: "ready" }).returning()
      const [d] = await db.insert(documents)
        .values({ tenantId: t!.id, sourceId: s!.id, title: "Policy" }).returning()
      await db.insert(chunks).values([
        { tenantId: t!.id, documentId: d!.id, ordinal: 0,
          content: "Official warranty 12 months.", embedding: fakeEmbedding(90), embeddingModel: "test" },
        { tenantId: t!.id, documentId: d!.id, ordinal: 1,
          content: "Open nine to five.", embedding: fakeEmbedding(91), embeddingModel: "test" },
      ])

      const store = createStore(db)
      const hits = await store.searchChunks({
        tenantId: t!.id, query: "warranty",
        embedding: fakeEmbedding(500), embeddingModel: "test", limit: 2,
      })
      expect(hits[0]!.content).toContain("warranty")
    })

    it("does not fall over on a question with no words in it", async () => {
      // `string_agg` over nothing is NULL, and `@@ NULL` matches nothing rather than erroring.
      const [t] = await db.insert(tenants).values({ slug: "fts3", name: "fts3" }).returning()
      await db.insert(tenantSettings).values({ tenantId: t!.id })
      const store = createStore(db)
      await expect(
        store.searchChunks({
          tenantId: t!.id, query: "???", embedding: fakeEmbedding(1),
          embeddingModel: "test", limit: 2,
        }),
      ).resolves.toEqual([])
    })
  })
})
