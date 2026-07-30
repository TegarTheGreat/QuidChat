import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { notifyEscalation } from "./escalation-notify.js"

let db: QuidDb

beforeAll(async () => {
  db = await freshPglite()
})

async function seedTenant(slug: string, mode: string, target: string | null): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({
    tenantId: tenant!.id,
    escalationMode: mode,
    ...(target === null ? {} : { escalationTarget: target }),
  })
  return tenant!.id
}

const notice = (tenantId: string) => ({
  tenantId,
  conversationId: "11111111-1111-1111-1111-111111111111",
  question: "Do you deliver to Bali?",
  reason: "no_source",
  channel: "web",
})

describe("notifyEscalation", () => {
  it("posts the question and reason to the configured webhook", async () => {
    const tenantId = await seedTenant("esc-webhook", "webhook", "https://relay.example/hook")
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) => new Response("", { status: 200 }))

    await notifyEscalation({
      db,
      notice: notice(tenantId),
      logError: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://relay.example/hook")
    // The question is the payload's reason for existing: without it the notice says something
    // went wrong but not what to write.
    expect(JSON.parse(init.body as string)).toEqual({
      event: "escalation",
      reason: "no_source",
      question: "Do you deliver to Bali?",
      channel: "web",
      conversationId: "11111111-1111-1111-1111-111111111111",
    })
  })

  it("sends nothing when the tenant has not asked for delivery", async () => {
    const collect = await seedTenant("esc-collect", "collect_contact", "https://relay.example/hook")
    const noTarget = await seedTenant("esc-no-target", "webhook", null)
    const blankTarget = await seedTenant("esc-blank-target", "webhook", "   ")
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }))

    for (const tenantId of [collect, noTarget, blankTarget]) {
      await notifyEscalation({
        db,
        notice: notice(tenantId),
        logError: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    }
    // A mode of collect_contact with a leftover target must not post: the setting the owner
    // chose is the mode, and honouring a stale URL instead would leak questions to it.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("logs a failure instead of throwing it at the customer's request", async () => {
    const tenantId = await seedTenant("esc-broken", "webhook", "https://relay.example/gone")
    const logged: string[] = []

    await notifyEscalation({
      db,
      notice: notice(tenantId),
      logError: (message) => logged.push(message),
      fetchImpl: async () => new Response("", { status: 404 }),
    })
    // The status is in the message on purpose: a 404 means the URL is wrong and a 401 means
    // the token is, and those are different fixes for what is otherwise one silence.
    expect(logged.join(" ")).toMatch(/404/)

    await expect(
      notifyEscalation({
        db,
        notice: notice(tenantId),
        logError: (message) => logged.push(message),
        fetchImpl: async () => {
          throw new Error("connection refused")
        },
      }),
    ).resolves.toBeUndefined()
    expect(logged.join(" ")).toMatch(/webhook failed/)
  })
})
