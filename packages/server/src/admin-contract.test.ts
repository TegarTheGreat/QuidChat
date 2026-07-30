import type { AddressInfo } from "node:net"
import { FakeProvider } from "@quidchat/core/testing"
import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { beforeAll, describe, expect, it, vi } from "vitest"
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
    env: { QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN },
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

    // Each of these was typed as an array and answered with a wrapper object. `Array.isArray`
    // is the assertion that failed to exist: the pages call .map and .find on these.
    expect(Array.isArray(await api.listTenants())).toBe(true)
    expect(Array.isArray(await api.listSources("contract"))).toBe(true)
    expect(Array.isArray(await api.listConversations("contract"))).toBe(true)
    expect(Array.isArray(await api.listEscalations("contract"))).toBe(true)
  })

  it("round-trips a text source through the fields the page reads", async () => {
    const api = await client()
    await api.createTextSource({
      tenantSlug: "contract",
      title: "Store Policy",
      text: "Returns are accepted within seven days of purchase.",
    })

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

/** Closes the server after the last test, so the file does not hold the worker open. */
describe("teardown", () => {
  it("stops the server", async () => {
    await close()
    expect(true).toBe(true)
  })
})
