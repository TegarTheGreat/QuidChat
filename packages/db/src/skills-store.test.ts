import { beforeAll, describe, expect, it } from "vitest"
import { createStore } from "./store.js"
import {
  chunks, conversations, documents, knowledgeSources, routingRules, skills, skillSources,
  tenants, tenantSettings,
} from "./schema.js"
import { freshPglite } from "./testing.js"

// Every fixture chunk below has `embedding: null`, so only the keyword path can ever
// find them — this vector exists purely to satisfy `vector(1536)`'s dimension
// requirement in the `<=>` comparison, not to carry any real semantic meaning.
const ZERO_EMBEDDING = Array.from({ length: 1536 }, () => 0)

/**
 * Two knowledge sources, each holding content the OTHER doesn't have, plus a skill
 * linked to only one of them. This is spec §3.5's second isolation boundary — knowledge
 * scoping WITHIN one tenant, as opposed to RLS which scopes ACROSS tenants — and it must
 * be proven against a real retrieval query, not an application-level filter (mandatory
 * test #4 in the design doc).
 */
async function seed(db: Awaited<ReturnType<typeof freshPglite>>) {
  const [t] = await db.insert(tenants).values({ slug: "scoped", name: "Scoped Co" }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })

  const [sourceOne] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "one.txt", status: "ready" }).returning()
  const [sourceTwo] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "two.txt", status: "ready" }).returning()

  const [docOne] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: sourceOne!.id, title: "Source One" }).returning()
  const [docTwo] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: sourceTwo!.id, title: "Source Two" }).returning()

  await db.insert(chunks).values([
    { tenantId: t!.id, documentId: docOne!.id, ordinal: 0,
      content: "Our warranty covers twelve months from the date of purchase.",
      embedding: null, embeddingModel: "test" },
    { tenantId: t!.id, documentId: docTwo!.id, ordinal: 0,
      content: "Refund requests are processed within fourteen business days.",
      embedding: null, embeddingModel: "test" },
  ])

  const [sales] = await db.insert(skills).values({
    tenantId: t!.id, name: "Sales", systemPrompt: "You help with sales.",
    enabled: true, isFallback: true,
  }).returning()
  await db.insert(skillSources).values({ tenantId: t!.id, skillId: sales!.id, sourceId: sourceOne!.id })

  const [rule] = await db.insert(routingRules).values({
    tenantId: t!.id, skillId: sales!.id, position: 0, kind: "fallback", pattern: null, enabled: true,
  }).returning()

  const [conversation] = await db.insert(conversations)
    .values({ tenantId: t!.id, channel: "widget", visitorId: "v1" }).returning()

  return {
    tenantId: t!.id, salesSkillId: sales!.id, sourceOneId: sourceOne!.id, sourceTwoId: sourceTwo!.id,
    ruleId: rule!.id, conversationId: conversation!.id,
  }
}

describe("skill-scoped retrieval and skill/routing store methods", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let fixture: Awaited<ReturnType<typeof seed>>

  beforeAll(async () => {
    db = await freshPglite()
    fixture = await seed(db)
  })

  it(
    "a skill linked only to source one cannot find an answer that lives only in source two",
    async () => {
      const store = createStore(db)
      const linkedSourceIds = await store.sourceIdsForSkill({
        tenantId: fixture.tenantId, skillId: fixture.salesSkillId,
      })
      expect(linkedSourceIds).toEqual([fixture.sourceOneId])

      // Control: with NO scoping, the refund content IS findable — proves the miss
      // below comes from the scope filter, not from the query being broken outright.
      const unscoped = await store.searchChunks({
        tenantId: fixture.tenantId, query: "refund", embedding: ZERO_EMBEDDING, embeddingModel: "test", limit: 5,
      })
      expect(unscoped.map((h) => h.content)).toContain(
        "Refund requests are processed within fourteen business days.",
      )

      // Scoped to the Sales skill's linked sources (source one only): the refund
      // answer lives in source two, so it must NOT be found — refusal, not a leak.
      const scoped = await store.searchChunks({
        tenantId: fixture.tenantId, query: "refund", embedding: ZERO_EMBEDDING, embeddingModel: "test", limit: 5,
        sourceIds: linkedSourceIds,
      })
      expect(scoped).toEqual([])

      // Sanity check the other direction too: content that DOES live in the linked
      // source is still found once scoped, so the filter isn't just discarding everything.
      const scopedHit = await store.searchChunks({
        tenantId: fixture.tenantId, query: "warranty", embedding: ZERO_EMBEDDING, embeddingModel: "test", limit: 5,
        sourceIds: linkedSourceIds,
      })
      expect(scopedHit.map((h) => h.content)).toContain(
        "Our warranty covers twelve months from the date of purchase.",
      )
    },
  )

  it("listSkills, listRoutingRules, sourceIdsForSkill, and incrementHandoffCount are wired to the schema", async () => {
    const store = createStore(db)

    const skillRows = await store.listSkills(fixture.tenantId)
    expect(skillRows).toHaveLength(1)
    expect(skillRows[0]).toMatchObject({
      id: fixture.salesSkillId, name: "Sales", systemPrompt: "You help with sales.",
      enabled: true, isFallback: true, answerMode: null,
    })

    const ruleRows = await store.listRoutingRules(fixture.tenantId)
    expect(ruleRows).toHaveLength(1)
    expect(ruleRows[0]).toMatchObject({
      id: fixture.ruleId, skillId: fixture.salesSkillId, position: 0, kind: "fallback",
      pattern: null, enabled: true,
    })

    const first = await store.incrementHandoffCount({
      tenantId: fixture.tenantId, conversationId: fixture.conversationId,
    })
    expect(first).toBe(1)
    const second = await store.incrementHandoffCount({
      tenantId: fixture.tenantId, conversationId: fixture.conversationId,
    })
    expect(second).toBe(2)
  })
})
