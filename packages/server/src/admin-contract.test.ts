import type { AddressInfo } from "node:net"
import { FakeProvider } from "@quidchat/core/testing"
import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { rowsOf } from "./admin/shared.js"
import { createServer } from "./server.js"

/**
 * The admin panel's own API client, run against the real admin API.
 *
 * This file exists because five defects got past everything else. The client typed four list
 * endpoints as arrays while the server answered with `{ tenants: [...] }`, and it read
 * `createdAt` where the server sends `occurredAt`. Both sides typechecked, every unit test
 * passed, and every one of those screens was broken the moment it touched a real server —
 * because nothing in the repo ever ran the client against it. A mocked `api` module cannot
 * find this class of bug: the mock agrees with whatever the client believes.
 *
 * So: the actual client module, the actual HTTP server, one PGlite database. If the two ever
 * disagree about a field name or a wrapper object again, this fails.
 */

let db: QuidDb
let baseUrl: string
let close: () => Promise<void>

const ADMIN_TOKEN = "contract-token"

beforeAll(async () => {
  db = await freshPglite()
  const [tenant] = await db.insert(tenants).values({ slug: "contract", name: "Contract" }).returning()
  await db.insert(tenantSettings).values({
    tenantId: tenant!.id,
    allowedOrigins: ["https://contract.example"],
  })

  const server = createServer({
    db,
    provider: new FakeProvider([]),
    logError: () => {},
    env: {
      QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN,
      // A real 32-byte key, so the channel routes below exercise encryption rather than the
      // "no key configured" path.
      QUIDCHAT_SECRET_KEY: Buffer.alloc(32, 3).toString("base64"),
    },
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise<void>((resolve) => server.close(() => resolve()))

  // The client builds root-relative URLs and reads its token from sessionStorage, because it
  // normally runs in a browser served by this same origin. Both are supplied here rather than
  // reimplemented: a stub of the client's own request layer would be a stub of the thing under
  // test.
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    return realFetch(url.startsWith("/") ? `${baseUrl}${url}` : url, init)
  })
  const store = new Map<string, string>([["quidchat-admin-token", ADMIN_TOKEN]])
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
})

/** Imported lazily so the sessionStorage stub is in place before the module reads its token. */
async function client() {
  return (await import("../../admin/src/lib/api.js")).api
}

describe("the admin panel's client against the admin API", () => {
  it("gets arrays from every list endpoint", async () => {
    const api = await client()
    // A tenant row carries id, slug and name. It used to declare `origins`, which this route has
    // never sent — allowed origins live in settings.
    const tenantRows = await api.listTenants()
    expect(tenantRows[0]).toMatchObject({ slug: "contract", name: "Contract" })
    expect(typeof tenantRows[0]!.id).toBe("string")

    // Each of these was typed as an array and answered with a wrapper object. `Array.isArray`
    // is the assertion that failed to exist: the pages call .map and .find on these.
    expect(Array.isArray(await api.listTenants())).toBe(true)
    expect(Array.isArray(await api.listSources("contract"))).toBe(true)
    expect(Array.isArray(await api.listConversations("contract"))).toBe(true)
    expect(Array.isArray(await api.listEscalations("contract"))).toBe(true)
  })

  it("round-trips a text source through the fields the page reads", async () => {
    const api = await client()
    const created = await api.createTextSource({
      tenantSlug: "contract",
      title: "Store Policy",
      text: "Returns are accepted within seven days of purchase.",
    })
    // The create route reports what indexing produced rather than a source row. It was typed as
    // a `Source` — a shape it has never returned.
    expect(created.sourceId).toBeTruthy()
    expect(created.status).toBe("ready")

    const sources = await api.listSources("contract")
    const source = sources.find((s) => s.title === "Store Policy")
    expect(source).toBeDefined()
    // `title` and `status` are what the Knowledge table renders; a renamed column would show
    // as an empty cell rather than as a failure.
    expect(source!.status).toMatch(/ready|error/)
    expect(typeof source!.id).toBe("string")
  })

  it("round-trips a canned answer, including its approval state", async () => {
    const api = await client()
    const created = await api.createCannedAnswer({
      tenantSlug: "contract",
      question: "How long is the warranty?",
      answer: "One year from purchase.",
      approved: true,
    })
    expect(created.cannedAnswer.status).toBe("approved")
    // createdAt, not created_at: the create and list routes returned different shapes for the
    // same row until this was unified.
    expect(created.cannedAnswer.createdAt).toBeTruthy()

    const { cannedAnswers } = await api.listCannedAnswers("contract")
    const found = cannedAnswers.find((c) => c.question === "How long is the warranty?")
    expect(found?.status).toBe("approved")

    await api.setCannedAnswerStatus({ tenantSlug: "contract", id: found!.id, approved: false })
    const after = await api.listCannedAnswers("contract")
    expect(after.cannedAnswers.find((c) => c.id === found!.id)?.status).toBe("draft")
  })

  it("reads settings under the exact keys the settings form writes back", async () => {
    const api = await client()
    const settings = await api.getSettings("contract")
    // The form binds directly to these names and PATCHes them back, so a mismatch here writes
    // an unknown column and the API answers 400 — which is what the allowlist is for.
    for (const key of [
      "answer_mode", "chat_model", "refusal_text", "escalation_mode", "escalation_target",
      "monthly_budget_cents", "retention_days", "high_risk_topics", "allowed_origins",
      "max_handoffs_per_turn", "max_handoffs_per_conversation",
    ]) {
      expect(settings, key).toHaveProperty(key)
    }

    const updated = await api.updateSettings({ tenantSlug: "contract", answer_mode: "thrifty" })
    expect(updated.answer_mode).toBe("thrifty")
  })

  it("saves the settings row the way the dialog actually saves it", async () => {
    /*
     * The dialog reads the whole row and writes it back. Doing that failed twice over, and every
     * save from the panel returned 400 — models, refusal text, budget, retention, origins,
     * handoff limits and the entire widget theme were unreachable, on a product whose rule is
     * that configuration lives in the panel.
     *
     * Both halves were invisible to a test that patches one field at a time: the row carries
     * `tenant_id`, which the API refuses as unknown, and it carries `escalation_target: null`
     * for any tenant that has never set a webhook, which the API refused as "must be a string".
     * This test round-trips the row, which is the thing the dialog does.
     */
    const api = await client()
    const { settingsPayload } = await import("../../admin/src/components/settings-payload.js")

    const fetched = await api.getSettings("contract")
    expect(fetched).toHaveProperty("tenant_id")
    expect(fetched.escalation_target).toBeNull()

    const saved = await api.updateSettings({
      ...settingsPayload(fetched, { primaryColor: "#123456", locale: "id" }),
      tenantSlug: "contract",
    })

    expect(saved.widget_theme).toMatchObject({ primaryColor: "#123456", locale: "id" })
    expect(saved.escalation_target).toBeNull()
  })

  it("can change and remove a skill, not only create one", async () => {
    /*
     * A skill could be created and then never touched: no rename, no edit, no way to switch it
     * off, no way to delete it. A business whose Sales persona was wrong had to create a second
     * one and leave the first still answering customers.
     */
    const api = await client()
    const { skill } = await api.createSkill({ tenantSlug: "contract", name: "Temporary" })

    await api.updateSkill({ tenantSlug: "contract", id: skill.id, name: "Renamed", enabled: false })
    let listed = await api.getSkills("contract")
    let found = listed.skills.find((s) => s.id === skill.id)
    expect(found?.name).toBe("Renamed")
    expect(found?.enabled).toBe(false)

    await api.updateSkill({ tenantSlug: "contract", id: skill.id, enabled: true })
    listed = await api.getSkills("contract")
    expect(listed.skills.find((s) => s.id === skill.id)?.enabled).toBe(true)

    await api.deleteSkill({ tenantSlug: "contract", id: skill.id })
    listed = await api.getSkills("contract")
    expect(listed.skills.some((s) => s.id === skill.id)).toBe(false)
  })

  it("keeps exactly one fallback when a second is promoted", async () => {
    // Two fallbacks would make routing depend on row order, which an owner cannot see or reason
    // about; none would leave unmatched questions nowhere to go.
    const api = await client()
    const first = (await api.createSkill({ tenantSlug: "contract", name: "FallbackA" })).skill
    const second = (await api.createSkill({ tenantSlug: "contract", name: "FallbackB" })).skill

    await api.updateSkill({ tenantSlug: "contract", id: first.id, isFallback: true })
    await api.updateSkill({ tenantSlug: "contract", id: second.id, isFallback: true })

    const listed = await api.getSkills("contract")
    expect(listed.skills.filter((s) => s.isFallback).map((s) => s.id)).toEqual([second.id])

    await api.deleteSkill({ tenantSlug: "contract", id: first.id })
    await api.deleteSkill({ tenantSlug: "contract", id: second.id })
  })

  it("can remove a routing rule, not only add one", async () => {
    // Rules could be created and never removed. A keyword typed wrongly sat in the ladder
    // forever, catching messages meant for the skill below it.
    const api = await client()
    const { skill } = await api.createSkill({ tenantSlug: "contract", name: "RuleOwner" })
    const rule = await api.createRoutingRule({
      tenantSlug: "contract", skillId: skill.id, kind: "keyword", pattern: "typo",
    })

    await api.deleteRoutingRule({ tenantSlug: "contract", id: rule.rule.id })
    const listed = await api.getSkills("contract")
    expect(listed.rules.some((r) => r.id === rule.rule.id)).toBe(false)
    await api.deleteSkill({ tenantSlug: "contract", id: skill.id })
  })

  it("sends an edited answer back for approval", async () => {
    // The approval was for the old words. Letting an edit keep `approved` would put text nobody
    // read in front of customers, which is the one thing the draft state exists to prevent.
    const api = await client()
    const created = await api.createCannedAnswer({
      tenantSlug: "contract", question: "Price?", answer: "Ten.",
    })
    await api.setCannedAnswerStatus({ tenantSlug: "contract", id: created.cannedAnswer.id, approved: true })

    const edited = await api.updateCannedAnswer({
      tenantSlug: "contract", id: created.cannedAnswer.id, answer: "Twelve.",
    })
    expect(edited.cannedAnswer.status).toBe("draft")

    await api.deleteCannedAnswer({ tenantSlug: "contract", id: created.cannedAnswer.id })
  })

  it("gets a skill, a rule and a source link back in the shape the screen groups by", async () => {
    const api = await client()
    const { skill } = await api.createSkill({ tenantSlug: "contract", name: "Sales" })
    await api.createRoutingRule({
      tenantSlug: "contract", skillId: skill.id, kind: "keyword", pattern: "price",
    })

    const { skills, rules } = await api.getSkills("contract")
    const sales = skills.find((s) => s.name === "Sales")
    expect(sales).toBeDefined()
    // The screen filters rules by skillId and sorts by position; both must be present and the
    // position must be a number, not a string from the driver.
    const rule = rules.find((r) => r.skillId === sales!.id)
    expect(rule?.kind).toBe("keyword")
    expect(typeof rule?.position).toBe("number")
    expect(Array.isArray(sales!.sources)).toBe(true)
  })

  it("reads a setup report the Setup screen can render", async () => {
    const api = await client()
    const setup = await api.getSetup("contract")
    expect(typeof setup.ready).toBe("boolean")
    expect(Array.isArray(setup.findings)).toBe(true)
    // Each finding is rendered as a card with these three fields.
    for (const finding of setup.findings) {
      expect(typeof finding.title).toBe("string")
      expect(typeof finding.why).toBe("string")
      expect(typeof finding.fix).toBe("string")
      expect(["blocker", "warning", "suggestion"]).toContain(finding.severity)
    }
  })
})

describe("usage and escalations", () => {
  it("reads this month's spend under the names the overview renders", async () => {
    const api = await client()
    const usage = await api.getUsage("contract")
    // The overview read `monthlyCostCents`, which the server has never sent, and the type had
    // an index signature so it compiled and rendered an empty figure. Named fields only now.
    expect(typeof usage.costCents).toBe("number")
    expect(typeof usage.inputTokens).toBe("number")
    expect(typeof usage.outputTokens).toBe("number")
  })

  it("marks an escalation handled and puts it back", async () => {
    const api = await client()
    // A tenant of its own, with nothing to answer from. The shared one has a document by this
    // point and would answer the question instead of escalating — and an escalation produced by
    // asking a real question is worth more here than a row inserted behind the API's back.
    const [bare] = await db.insert(tenants).values({ slug: "contract-bare", name: "Bare" }).returning()
    await db.insert(tenantSettings).values({
      tenantId: bare!.id,
      allowedOrigins: ["https://contract.example"],
    })
    const chat = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://contract.example" },
      body: JSON.stringify({ tenantSlug: "contract-bare", message: "do you deliver to Bali?" }),
    })
    expect(chat.status).toBe(200)

    const [escalation] = await api.listEscalations("contract-bare")
    expect(escalation?.question).toBe("do you deliver to Bali?")
    expect(escalation?.resolvedAt).toBeNull()

    const resolved = await api.resolveEscalation({
      tenantSlug: "contract-bare",
      id: escalation!.id,
      resolved: true,
    })
    expect(resolved.resolvedAt).toBeTruthy()

    const reopened = await api.resolveEscalation({
      tenantSlug: "contract-bare",
      id: escalation!.id,
      resolved: false,
    })
    expect(reopened.resolvedAt).toBeNull()
  })
})

describe("channel credentials", () => {
  it("saves a channel and reports which fields are stored, never their values", async () => {
    const api = await client()
    const saved = await api.saveChannel({
      tenantSlug: "contract",
      channel: "telegram",
      enabled: true,
      secrets: { botToken: "123456:CONTRACT-TOKEN", secretToken: "contract-hook-secret" },
    })
    expect(saved.configuredFields).toEqual(["botToken", "secretToken"])

    const listed = await api.listChannels("contract")
    expect(listed.secretKeyConfigured).toBe(true)
    const telegram = listed.channels.find((c) => c.channel === "telegram")
    expect(telegram?.enabled).toBe(true)
    expect(telegram?.configuredFields).toContain("botToken")
    expect(telegram?.error).toBeNull()

    // The screen renders from `fields`, so the contract includes it: a channel whose fields the
    // panel does not know about renders as a card with no inputs.
    // The webhook secret is required, not optional. Telegram lets you set one at `setWebhook`,
    // so one always exists — and without it the endpoint accepts anything that reaches the URL,
    // which is someone else putting words in this business's history and spending its budget.
    expect(listed.fields.telegram?.required).toEqual(["botToken", "secretToken"])

    // The whole response, serialised, must not contain either secret. Asserting on the parsed
    // object would miss a value that reached some other field name.
    expect(JSON.stringify(listed)).not.toMatch(/CONTRACT-TOKEN|contract-hook-secret/)
  })

  it("refuses an incomplete channel and names what is missing", async () => {
    const api = await client()
    await expect(
      api.saveChannel({
        tenantSlug: "contract",
        channel: "whatsapp",
        enabled: true,
        secrets: { phoneNumberId: "555" },
      }),
    ).rejects.toThrow(/accessToken/)
  })

  it("disconnects a channel, and says so when there is nothing to disconnect", async () => {
    const api = await client()
    expect(await api.deleteChannel({ tenantSlug: "contract", channel: "telegram" })).toEqual({ ok: true })
    // A second delete must not report success: an owner clicking twice should learn the channel
    // is already gone rather than believing they removed something.
    await expect(
      api.deleteChannel({ tenantSlug: "contract", channel: "telegram" }),
    ).rejects.toThrow(/not configured/)
  })

  it("erases a transcript and the messages under it", async () => {
    const api = await client()
    const tenantId = rowsOf(
      await db.execute(sql`SELECT id FROM tenants WHERE slug = 'contract'`),
    )[0]!["id"] as string
    const conversationId = rowsOf(
      await db.execute(sql`
        INSERT INTO conversations (tenant_id, channel, visitor_id)
        VALUES (${tenantId}, 'web', 'visitor-erasure') RETURNING id
      `),
    )[0]!["id"] as string
    await db.execute(sql`
      INSERT INTO messages (tenant_id, conversation_id, role, content)
      VALUES (${tenantId}, ${conversationId}, 'user', 'Please delete my data')
    `)

    expect((await api.listConversations("contract")).some((c) => c.id === conversationId)).toBe(true)
    expect(await api.deleteConversation({ tenantSlug: "contract", id: conversationId })).toEqual({
      ok: true,
    })
    expect((await api.listConversations("contract")).some((c) => c.id === conversationId)).toBe(
      false,
    )
    // The row is the easy half. A message left behind is the customer's words still on disk after
    // being told they were erased, which is the thing this route exists to prevent.
    const left = rowsOf(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversationId}`,
      ),
    )[0]
    expect(left).toMatchObject({ n: 0 })

    // Deleting the same one twice must not report success: an owner clicking again should learn
    // it is already gone.
    await expect(
      api.deleteConversation({ tenantSlug: "contract", id: conversationId }),
    ).rejects.toThrow(/not found/)
  })

  it("renames a tenant without touching its slug", async () => {
    const api = await client()
    const renamed = await api.renameTenant({ slug: "contract", name: "Contract Renamed" })
    expect(renamed.tenant).toMatchObject({ slug: "contract", name: "Contract Renamed" })
    // Read it back from the list the picker is built from, not from the reply: the point is that
    // the panel shows the new name after a refresh.
    const listed = (await api.listTenants()).find((t) => t.slug === "contract")
    expect(listed?.name).toBe("Contract Renamed")
    await api.renameTenant({ slug: "contract", name: "Contract" })
  })

  it("deletes a tenant only when the slug is repeated, and takes its knowledge with it", async () => {
    const api = await client()
    await api.createTenant({ slug: "throwaway", name: "Throwaway", origins: [] })
    await api.createTextSource({
      tenantSlug: "throwaway",
      title: "Harga",
      text: "Ongkir Jakarta gratis di atas Rp200.000.",
    })

    // A wrong confirmation must not delete anything. This is the guard the panel's type-the-slug
    // dialog relies on; without it the dialog is decoration a script could skip.
    await expect(
      api.deleteTenant({ slug: "throwaway", confirm: "throwaways" }),
    ).rejects.toThrow(/confirm/)
    expect((await api.listTenants()).some((t) => t.slug === "throwaway")).toBe(true)

    expect(await api.deleteTenant({ slug: "throwaway", confirm: "throwaway" })).toEqual({ ok: true })
    expect((await api.listTenants()).some((t) => t.slug === "throwaway")).toBe(false)
    // The row was the easy part. What matters is that nothing it owned outlived it — a source left
    // behind would be a shop's price list still sitting in a database it no longer has a login for.
    const orphans = await db.execute(
      sql`SELECT count(*)::int AS n FROM knowledge_sources ks
          LEFT JOIN tenants t ON t.id = ks.tenant_id WHERE t.id IS NULL`,
    )
    expect(rowsOf(orphans)[0]).toMatchObject({ n: 0 })
  })
})

/** Closes the server after the last test, so the file does not hold the worker open. */
describe("teardown", () => {
  it("stops the server", async () => {
    await close()
    expect(true).toBe(true)
  })
})
