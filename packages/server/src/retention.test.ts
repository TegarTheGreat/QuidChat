import { conversations, messages, tenants, tenantSettings, usageEvents, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { pruneExpiredConversations } from "./retention.js"

let db: QuidDb

beforeAll(async () => {
  db = await freshPglite()
})

async function seedTenant(slug: string, retentionDays: number): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: tenant!.id, retentionDays })
  return tenant!.id
}

/** Inserts a conversation with one message, aged by `daysAgo`. */
async function seedConversation(tenantId: string, daysAgo: number): Promise<string> {
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, channel: "web", visitorId: "v1" })
    .returning()
  const id = conversation!.id
  await db.insert(messages).values({ tenantId, conversationId: id, role: "user", content: "hi" })
  await db.execute(sql`
    UPDATE conversations SET created_at = now() - make_interval(days => ${daysAgo}) WHERE id = ${id}
  `)
  return id
}

describe("pruneExpiredConversations", () => {
  it("deletes only what is past the window, and takes its messages with it", async () => {
    const tenantId = await seedTenant("retention-window", 30)
    const old = await seedConversation(tenantId, 100)
    const recent = await seedConversation(tenantId, 5)

    const result = await pruneExpiredConversations(db)
    expect(result.byTenant).toContainEqual({ tenantId, deleted: 1 })

    const survivors = await db.select().from(conversations).where(eq(conversations.tenantId, tenantId))
    expect(survivors.map((c) => c.id)).toEqual([recent])

    // Messages follow by cascade rather than by a second DELETE, so the customer's text
    // cannot survive under a different table name.
    const remaining = await db.select().from(messages).where(eq(messages.tenantId, tenantId))
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.conversationId).toBe(recent)
    expect(old).not.toBe(recent)
  })

  it("treats zero as keep forever", async () => {
    const tenantId = await seedTenant("retention-off", 0)
    await seedConversation(tenantId, 5000)

    const result = await pruneExpiredConversations(db)
    expect(result.byTenant.find((t) => t.tenantId === tenantId)).toBeUndefined()
    expect(await db.select().from(conversations).where(eq(conversations.tenantId, tenantId))).toHaveLength(1)
  })

  it("does not touch another tenant's data or the spend record", async () => {
    const expiring = await seedTenant("retention-expiring", 1)
    const keeping = await seedTenant("retention-keeping", 3650)
    await seedConversation(expiring, 400)
    await seedConversation(keeping, 400)
    await db.insert(usageEvents).values({
      tenantId: expiring, model: "test", inputTokens: 10, outputTokens: 5, costCents: 1,
    })

    await pruneExpiredConversations(db)

    expect(await db.select().from(conversations).where(eq(conversations.tenantId, expiring))).toHaveLength(0)
    // A retention window is about personal data. Pruning usage would silently hand the
    // tenant more spend than they configured, because the budget is computed from it.
    expect(await db.select().from(usageEvents).where(eq(usageEvents.tenantId, expiring))).toHaveLength(1)
    expect(await db.select().from(conversations).where(eq(conversations.tenantId, keeping))).toHaveLength(1)
  })
})
