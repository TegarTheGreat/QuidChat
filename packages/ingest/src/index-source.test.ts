import { FakeProvider } from "@quidchat/core/testing"
import {
  createStore, knowledgeSources, tenants, tenantSettings, withTenant,
} from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import type { Provider, Store } from "@quidchat/core"
import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { indexSource } from "./index-source.js"

/** A provider whose `embed` always rejects, for the failure-path test. */
class FailingProvider implements Provider {
  readonly id = "failing-test-provider"
  constructor(private error: Error) {}
  async embed(): Promise<number[]> {
    throw this.error
  }
  complete(): never {
    throw new Error("not used by indexSource")
  }
  generateText(): never {
    throw new Error("not used by indexSource")
  }
  capabilities(): never {
    throw new Error("not used by indexSource")
  }
}

/** Seeds one tenant with its settings and a single pending `text` knowledge source. */
async function seedTenant(db: Awaited<ReturnType<typeof freshPglite>>, slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: `${slug}.txt`, status: "pending" }).returning()
  return { tenantId: t!.id, sourceId: s!.id }
}

/** Reads back a knowledge source's row, scoped through `withTenant` like every other read. */
async function readSource(db: Awaited<ReturnType<typeof freshPglite>>, tenantId: string, sourceId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT status, error, last_indexed_at FROM knowledge_sources WHERE id = ${sourceId}
    `)
    const rows = Array.isArray(res) ? res : (res as { rows: Record<string, unknown>[] }).rows
    return rows[0] as { status: string; error: string | null; last_indexed_at: string | null }
  })
}

const WARRANTY_TEXT = "Warranty covers twelve months from the date of purchase."
const SHIPPING_TEXT = "Shipping to remote islands takes five business days."

// Small target with no overlap so each sentence lands in its own chunk, and the second
// chunk shares no words with the first — required so the two retrievability assertions
// below genuinely isolate the keyword path from the vector path.
const CHUNK_OPTIONS = { target: 60, max: 200, overlapSentences: 0 }

describe("indexSource", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let store: Store

  beforeAll(async () => {
    db = await freshPglite()
    store = createStore(db)
  })

  it("indexes a source and the content comes back through search — proving ingestion and retrieval actually agree", async () => {
    const { tenantId, sourceId } = await seedTenant(db, "shop")
    const provider = new FakeProvider([])

    const result = await indexSource({
      tenantId, sourceId, title: "Store Policy", text: `${WARRANTY_TEXT}\n\n${SHIPPING_TEXT}`,
      embeddingModel: "test-embed-v1", store, provider, chunkOptions: CHUNK_OPTIONS,
    })
    expect(result.chunkCount).toBe(2)

    const source = await readSource(db, tenantId, sourceId)
    expect(source.status).toBe("ready")
    expect(source.error).toBeNull()
    expect(source.last_indexed_at).not.toBeNull()

    const queryEmbedding = await provider.embed({ model: "test-embed-v1", text: "irrelevant" })

    // Found via the KEYWORD path: the query shares a word with this chunk.
    const byKeyword = await store.searchChunks({
      tenantId, query: "warranty", embedding: queryEmbedding, embeddingModel: "test-embed-v1", limit: 5,
    })
    expect(byKeyword.map((h) => h.content)).toContain(WARRANTY_TEXT)

    // Found via the VECTOR path only: the query shares NO word with this chunk, so the
    // only way it can come back is the `sem` CTE, which requires `embedding IS NOT
    // NULL AND embedding_model = 'test-embed-v1'` — exactly what this call wrote.
    const bySemantic = await store.searchChunks({
      tenantId, query: "totally unrelated wombat inquiry",
      embedding: queryEmbedding, embeddingModel: "test-embed-v1", limit: 5,
    })
    expect(bySemantic.map((h) => h.content)).toContain(SHIPPING_TEXT)
  })

  it("indexing as one tenant leaves another tenant seeing nothing", async () => {
    const shop = await seedTenant(db, "tenant-scoping-shop")
    const other = await seedTenant(db, "tenant-scoping-other")
    const provider = new FakeProvider([])

    await indexSource({
      tenantId: shop.tenantId, sourceId: shop.sourceId, title: "Shop Policy", text: WARRANTY_TEXT,
      embeddingModel: "test-embed-v1", store, provider, chunkOptions: CHUNK_OPTIONS,
    })

    const embedding = await provider.embed({ model: "test-embed-v1", text: "warranty" })
    const asOwner = await store.searchChunks({
      tenantId: shop.tenantId, query: "warranty", embedding, embeddingModel: "test-embed-v1", limit: 5,
    })
    const asOther = await store.searchChunks({
      tenantId: other.tenantId, query: "warranty", embedding, embeddingModel: "test-embed-v1", limit: 5,
    })

    expect(asOwner.map((h) => h.content)).toContain(WARRANTY_TEXT)
    expect(asOther).toEqual([])
  })

  it("on an embedding failure, chunks are still written with a null embedding, the source is marked error, and the call rethrows", async () => {
    const { tenantId, sourceId } = await seedTenant(db, "broken")
    const provider = new FailingProvider(new Error("embedding provider unavailable"))

    await expect(
      indexSource({
        tenantId, sourceId, title: "Broken Doc", text: "Refunds are accepted within thirty days.",
        embeddingModel: "test-embed-v1", store, provider,
      }),
    ).rejects.toThrow("embedding provider unavailable")

    const source = await readSource(db, tenantId, sourceId)
    expect(source.status).toBe("error")
    expect(source.error).toContain("embedding provider unavailable")

    // The text is still there and findable via the keyword path, even with no vector —
    // this is the whole point of writing chunks before checking whether embedding failed.
    const hits = await store.searchChunks({
      tenantId, query: "refunds", embedding: Array.from({ length: 1536 }, () => 0),
      embeddingModel: "test-embed-v1", limit: 5,
    })
    expect(hits.map((h) => h.content)).toContain("Refunds are accepted within thirty days.")
  })
})
