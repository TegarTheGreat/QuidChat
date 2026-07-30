import type { AddressInfo } from "node:net"
import type { Store } from "@quidchat/core"
import { FakeProvider } from "@quidchat/core/testing"
import {
  chunks, conversations, createStore, documents, escalations, knowledgeSources, messages,
  tenants, tenantSettings, usageEvents, type QuidDb,
} from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type ServerDeps } from "./server.js"

const ALLOWED_ORIGIN = "https://widget.example.test"
const WARRANTY_TEXT = "Our warranty covers manufacturing defects for 12 months from the date of purchase."

/** Seeds one tenant with a document, one chunk, and the given origin allowlist.
 *  `monthlyBudgetCents` defaults to the column's own default (`0`, unlimited) when
 *  omitted, so existing callers that don't care about the budget are unaffected. */
async function seedTenant(
  db: QuidDb,
  args: {
    slug: string
    allowedOrigins: string[]
    chunkText?: string
    monthlyBudgetCents?: number
  },
): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ slug: args.slug, name: args.slug }).returning()
  await db.insert(tenantSettings).values({
    tenantId: tenant!.id,
    allowedOrigins: args.allowedOrigins,
    ...(args.monthlyBudgetCents !== undefined ? { monthlyBudgetCents: args.monthlyBudgetCents } : {}),
  })
  const [source] = await db.insert(knowledgeSources)
    .values({ tenantId: tenant!.id, kind: "text", uri: "policy.txt", status: "ready" })
    .returning()
  const [doc] = await db.insert(documents)
    .values({ tenantId: tenant!.id, sourceId: source!.id, title: "Policy" })
    .returning()
  await db.insert(chunks).values({
    tenantId: tenant!.id,
    documentId: doc!.id,
    ordinal: 0,
    content: args.chunkText ?? WARRANTY_TEXT,
    // No embedding: the vector path can't use it, so the test proves the keyword
    // path alone is enough to find the chunk — no fake embedding vector to fudge.
    embedding: null,
    embeddingModel: "text-embedding-3-small",
  })
  return tenant!.id
}

function postChat(
  baseUrl: string,
  body: unknown,
  opts?: { origin?: string; headers?: Record<string, string> },
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts?.headers }
  if (opts?.origin !== undefined) headers.origin = opts.origin
  return fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("chat endpoint", () => {
  let db: QuidDb
  let baseUrl: string
  let close: () => Promise<void>
  let loggedErrors: { message: string; cause: unknown }[]

  let shopTenantId: string

  beforeAll(async () => {
    db = await freshPglite()
    shopTenantId = await seedTenant(db, { slug: "shop", allowedOrigins: [ALLOWED_ORIGIN] })
    // "unconfigured" has an explicit EMPTY allowlist — the "not yet configured" case,
    // distinct from "shop" (configured) and "does-not-exist" (no such tenant at all).
    await seedTenant(db, { slug: "unconfigured", allowedOrigins: [] })

    loggedErrors = []
    const provider = new FakeProvider([{
      segments: [{
        kind: "business_claim",
        text: "The warranty covers manufacturing defects for 12 months.",
        citations: [], // filled in per-test where the real chunk id is needed
      }],
    }])

    const deps: ServerDeps = {
      db,
      provider,
      logError: (message, cause) => loggedErrors.push({ message, cause }),
    }
    const server = createServer(deps)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
    close = () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })

  afterAll(async () => {
    await close()
  })

  it("answers a visitor's question with a citation to the seeded document", async () => {
    // The citation is wired up here, not in the shared fixture above, because it
    // needs the real chunk id that only exists once the tenant is seeded.
    const [chunk] = await db.select({ id: chunks.id }).from(chunks)
      .where(eq(chunks.tenantId, shopTenantId))
    const provider = new FakeProvider([{
      segments: [{
        kind: "business_claim",
        text: "The warranty covers manufacturing defects for 12 months.",
        citations: [chunk!.id],
      }],
    }])
    const server = createServer({ db, provider, logError: () => {} })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${port}`

    try {
      // A single-word question, matched through the keyword path — the chunk carries
      // no embedding, so `plainto_tsquery` doing an AND-of-terms match is what's under
      // test, not `FakeProvider`'s constant embedding.
      const res = await postChat(url, { tenantSlug: "shop", message: "warranty" }, {
        origin: ALLOWED_ORIGIN,
      })
      expect(res.status).toBe(200)
      const json = await res.json() as {
        kind: string
        citations: { chunkId: string; documentTitle: string }[]
      }
      expect(json.kind).toBe("answered")
      expect(json.citations.length).toBeGreaterThan(0)
      // The document TITLE crosses the API, not just the chunk id. This is what the
      // widget shows a visitor, and a UUID would satisfy "you can see the source"
      // without telling them anything. "Policy" is the title seeded above.
      expect(json.citations[0]!.documentTitle).toBe("Policy")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("refuses with a 200 when nothing in the knowledge base is relevant", async () => {
    const res = await postChat(baseUrl, {
      tenantSlug: "shop",
      message: "Do you offer intergalactic teleportation services?",
    }, { origin: ALLOWED_ORIGIN })
    expect(res.status).toBe(200)
    const json = await res.json() as { kind: string; reason: string }
    expect(json.kind).toBe("refused")
    expect(json.reason).toBe("no_source")
  })

  it("returns 404 for an unknown tenant slug", async () => {
    const res = await postChat(baseUrl, {
      tenantSlug: "does-not-exist",
      message: "Hello?",
    }, { origin: ALLOWED_ORIGIN })
    expect(res.status).toBe(404)
  })

  it("returns 403 when the Origin header is not in the tenant's allowlist, even for a valid slug", async () => {
    const res = await postChat(baseUrl, {
      tenantSlug: "shop",
      message: "How long is the warranty?",
    }, { origin: "https://impostor.example.test" })
    expect(res.status).toBe(403)
  })

  it("returns 403 when allowed_origins is empty, rather than treating it as open", async () => {
    const res = await postChat(baseUrl, {
      tenantSlug: "unconfigured",
      message: "How long is the warranty?",
    }, { origin: "https://anything.example.test" })
    expect(res.status).toBe(403)
  })

  it("returns 403 when there is no Origin header at all", async () => {
    const res = await postChat(baseUrl, {
      tenantSlug: "shop",
      message: "How long is the warranty?",
    })
    expect(res.status).toBe(403)
  })

  it("returns 400 for a malformed body", async () => {
    const res = await postChat(baseUrl, "{ this is not valid json", { origin: ALLOWED_ORIGIN })
    expect(res.status).toBe(400)
  })

  it("returns 405 for a GET request on the chat path", async () => {
    const res = await fetch(`${baseUrl}/chat`, { method: "GET" })
    expect(res.status).toBe(405)
  })

  it("responds 503 without leaking internals, logs the failure, and records no escalation when the store fails", async () => {
    // The cleanest way to force a genuine STORE failure: a real store, wired to the
    // real database, with exactly one method replaced by one that throws. Every other
    // method — getTenantConfig, recordUserTurn, recordAnswer, recordEscalation — still
    // works, so nothing besides `searchChunks` is under test here.
    const brokenStore: Store = {
      ...createStore(db),
      searchChunks() {
        // A realistic internal failure: a connection string, a table name — exactly
        // what must NEVER reach the visitor. Asserted below.
        return Promise.reject(
          new Error("connection to 10.0.4.12:5432 failed: relation \"chunks\" does not exist"),
        )
      },
    }
    const loggedHere: { message: string; cause: unknown }[] = []
    const provider = new FakeProvider([{
      segments: [{ kind: "general", text: "should never be reached" }],
    }])
    const server = createServer({
      db, provider, store: brokenStore,
      logError: (message, cause) => loggedHere.push({ message, cause }),
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${port}`

    try {
      // A delta, not an absolute count: earlier tests in this file legitimately
      // record `no_source` escalations, so "the table is empty" is the wrong
      // assertion — "this request added nothing to it" is the right one.
      const escalationsBefore = await db.select({ id: escalations.id }).from(escalations)

      const res = await postChat(url, { tenantSlug: "shop", message: "warranty" }, {
        origin: ALLOWED_ORIGIN,
      })

      expect(res.status).toBe(503)
      const json = await res.json() as { error: string }
      // Neutral and visitor-safe: no schema names, no connection strings, no query text.
      expect(json.error).toBe("temporarily unavailable")
      expect(json.error).not.toMatch(/10\.0\.4\.12|relation|chunks|connection/i)

      expect(loggedHere.length).toBeGreaterThan(0)

      const escalationsAfter = await db.select({ id: escalations.id }).from(escalations)
      expect(escalationsAfter.length).toBe(escalationsBefore.length)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("creates a conversation on the first message and reuses it on the next", async () => {
    const [chunk] = await db.select({ id: chunks.id }).from(chunks)
      .where(eq(chunks.tenantId, shopTenantId))
    const provider = new FakeProvider([{
      segments: [{
        kind: "business_claim",
        text: "The warranty covers manufacturing defects for 12 months.",
        citations: [chunk!.id],
      }],
    }])
    const server = createServer({ db, provider, logError: () => {} })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${port}`

    try {
      const first = await postChat(url, {
        tenantSlug: "shop",
        message: "warranty",
      }, { origin: ALLOWED_ORIGIN })
      expect(first.status).toBe(200)
      const firstJson = await first.json() as { conversationId: string }
      expect(firstJson.conversationId).toBeTruthy()

      // "defects" is a second word from the same chunk, so this follow-up is
      // answered too, rather than refused — the transcript below needs two
      // assistant turns, not one answer and one refusal.
      const second = await postChat(url, {
        tenantSlug: "shop",
        conversationId: firstJson.conversationId,
        message: "defects",
      }, { origin: ALLOWED_ORIGIN })
      expect(second.status).toBe(200)
      const secondJson = await second.json() as { conversationId: string }
      expect(secondJson.conversationId).toBe(firstJson.conversationId)

      const transcript = await db.select({ role: messages.role }).from(messages)
        .where(eq(messages.conversationId, firstJson.conversationId))
      expect(transcript.length).toBe(4)
      expect(transcript.filter((m) => m.role === "user").length).toBe(2)
      expect(transcript.filter((m) => m.role === "assistant").length).toBe(2)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  describe("conversation ownership", () => {
    it("will not let one visitor write into another's conversation", async () => {
      const provider = new FakeProvider([
        { segments: [{ kind: "general", text: "Sure." }] },
        { segments: [{ kind: "general", text: "Sure." }] },
      ])
      const server = createServer({ db, provider, logError: () => {} })
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const port = (server.address() as AddressInfo).port
      const url = `http://127.0.0.1:${port}`

      const ask = (body: Record<string, unknown>) =>
        fetch(`${url}/v1/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
          body: JSON.stringify({ tenantSlug: "shop", ...body }),
        }).then((r) => r.json() as Promise<{ conversationId: string }>)

      try {
        const first = await ask({ message: "hello" })
        // The same socket means the same visitor, so their own id continues their own thread.
        const continued = await ask({ message: "again", conversationId: first.conversationId })
        expect(continued.conversationId).toBe(first.conversationId)

        // A conversation id from a tenant's own database, offered by someone who is not its
        // visitor. It used to be taken on trust, which made the id a capability: whatever was
        // posted landed in the history the model reads for that visitor's next answer.
        const stranger = await db
          .insert(conversations)
          .values({ tenantId: shopTenantId, channel: "web", visitorId: "10.9.9.9" })
          .returning()
        const hijacked = await ask({ message: "injected", conversationId: stranger[0]!.id })
        expect(hijacked.conversationId).not.toBe(stranger[0]!.id)

        // And nothing was written into it.
        const theirs = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, stranger[0]!.id))
        expect(theirs).toHaveLength(0)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })

  it("answers a message carrying a NUL byte instead of failing on it", async () => {
    const provider = new FakeProvider([{ segments: [{ kind: "general", text: "Sure." }] }])
    const server = createServer({ db, provider, logError: () => {} })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    try {
      // Postgres will not store a NUL in a text column, so this used to throw on the insert and
      // the visitor got a 503 for a message that would never have worked however many times they
      // tried it.
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ tenantSlug: "shop", message: "what is the\u0000 warranty?" }),
      })
      expect(res.status).toBe(200)

      const stored = await db.select().from(messages).where(eq(messages.role, "user"))
      // Stripped, not escaped: the rest of the sentence is what the customer meant.
      expect(stored.some((m) => m.content.includes("\u0000"))).toBe(false)
      expect(stored.some((m) => m.content === "what is the warranty?")).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })


  it("sends only the recent history, oldest of the recent first", async () => {
    // Every message used to go into every prompt, so a long conversation grew its own cost with
    // each turn and would eventually exceed the model's context window — failing for a reason no
    // customer could understand. Twenty messages is the bound; the OLDEST have to fall off.
    const seen: { role: string; content: string }[][] = []
    const provider = {
      complete: async (args: { prompt: { history: { role: string; content: string }[] } }) => {
        seen.push(args.prompt.history)
        return {
          answer: { segments: [{ kind: "general" as const, text: "Noted." }] },
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null },
        }
      },
      embed: async () => Array.from({ length: 1536 }, () => 0.01),
      generateText: async () => "",
    }

    const server = createServer({
      db,
      provider: provider as never,
      logError: () => {},
      // Fourteen turns is more than a visitor is allowed in a burst, and being throttled is the
      // rate limiter working. Raised here so this test measures the thing it is about.
      rateLimits: { visitor: { capacity: 100, refillPerSecond: 100 } },
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const ask = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/v1/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
          body: JSON.stringify({ tenantSlug: "shop", ...body }),
        }).then((r) => r.json() as Promise<{ conversationId: string }>)

      // Every question has to retrieve something or the pipeline refuses before it reaches the
      // model, and full-text search ANDs its terms — so each of these is built only from words
      // the seeded document actually contains.
      const questions = [
        "warranty", "covers", "manufacturing", "defects", "months", "purchase", "date",
        "warranty covers", "manufacturing defects", "months purchase", "warranty months",
        "covers defects", "date purchase", "warranty date",
      ]
      const first = await ask({ message: questions[0]! })
      for (const message of questions.slice(1)) {
        await ask({ message, conversationId: first.conversationId })
      }

      expect(seen).toHaveLength(questions.length)
      const lastPrompt = seen[seen.length - 1]!
      expect(lastPrompt.length).toBeLessThanOrEqual(20)
      // Still in the order they were said, and it is the earliest that is gone.
      expect(lastPrompt[0]!.content).not.toBe(questions[0])
      expect(lastPrompt[lastPrompt.length - 1]!.content).toBe("Noted.")
      expect(lastPrompt.some((m) => m.content === questions[questions.length - 2])).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

})

describe("budget enforcement", () => {
  let db: QuidDb

  let underTenantId: string
  let overTenantId: string
  let unlimitedTenantId: string
  let accumulateTenantId: string

  beforeAll(async () => {
    db = await freshPglite()
    underTenantId = await seedTenant(db, {
      slug: "budget-under", allowedOrigins: [ALLOWED_ORIGIN], monthlyBudgetCents: 1_000,
    })
    overTenantId = await seedTenant(db, {
      slug: "budget-over", allowedOrigins: [ALLOWED_ORIGIN], monthlyBudgetCents: 100,
    })
    unlimitedTenantId = await seedTenant(db, {
      slug: "budget-unlimited", allowedOrigins: [ALLOWED_ORIGIN], monthlyBudgetCents: 0,
    })
    accumulateTenantId = await seedTenant(db, {
      slug: "budget-accumulate", allowedOrigins: [ALLOWED_ORIGIN], monthlyBudgetCents: 1,
    })

    // Prior spend is inserted directly here, decoupling these two tenants from
    // `recordUsage`'s cost estimate — only the pre-flight COMPARISON in chat.ts is
    // under test for them. The accumulation test below exercises the real write path.
    await db.insert(usageEvents).values({
      tenantId: overTenantId, model: "claude-opus-5", inputTokens: 10, outputTokens: 10, costCents: 100,
    })
    await db.insert(usageEvents).values({
      tenantId: unlimitedTenantId, model: "claude-opus-5", inputTokens: 10, outputTokens: 10, costCents: 999_999,
    })
  })

  async function chunkIdFor(tenantId: string): Promise<string> {
    const [chunk] = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.tenantId, tenantId))
    return chunk!.id
  }

  async function startServer(provider: FakeProvider): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer({ db, provider, logError: () => {} })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  it("answers normally when this month's spend is under a non-zero budget", async () => {
    const chunkId = await chunkIdFor(underTenantId)
    const provider = new FakeProvider([{
      segments: [{ kind: "business_claim", text: "Answered.", citations: [chunkId] }],
    }])
    const { url, close } = await startServer(provider)
    try {
      const res = await postChat(url, { tenantSlug: "budget-under", message: "warranty" }, {
        origin: ALLOWED_ORIGIN,
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { kind: string }
      expect(json.kind).toBe("answered")
      expect(provider.calls.length).toBe(1)
    } finally {
      await close()
    }
  })

  it("refuses with budget_exhausted and never calls the provider once spend has reached the budget", async () => {
    const chunkId = await chunkIdFor(overTenantId)
    const provider = new FakeProvider([{
      segments: [{ kind: "business_claim", text: "Should never be produced.", citations: [chunkId] }],
    }])
    const { url, close } = await startServer(provider)
    try {
      const res = await postChat(url, { tenantSlug: "budget-over", message: "warranty" }, {
        origin: ALLOWED_ORIGIN,
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { kind: string; reason: string }
      expect(json.kind).toBe("refused")
      expect(json.reason).toBe("budget_exhausted")
      // The whole point: not embed, not complete — no provider call happened at all.
      expect(provider.calls.length).toBe(0)
      expect(provider.embedCalls.length).toBe(0)
    } finally {
      await close()
    }
  })

  it("answers regardless of accumulated spend when the budget is zero (unlimited)", async () => {
    const chunkId = await chunkIdFor(unlimitedTenantId)
    const provider = new FakeProvider([{
      segments: [{ kind: "business_claim", text: "Answered anyway.", citations: [chunkId] }],
    }])
    const { url, close } = await startServer(provider)
    try {
      const res = await postChat(url, { tenantSlug: "budget-unlimited", message: "warranty" }, {
        origin: ALLOWED_ORIGIN,
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { kind: string }
      expect(json.kind).toBe("answered")
      expect(provider.calls.length).toBe(1)
    } finally {
      await close()
    }
  })

  it("records usage after a successful answer, so accumulated spend can reach the budget on a later request", async () => {
    const chunkId = await chunkIdFor(accumulateTenantId)
    const provider = new FakeProvider([{
      segments: [{
        kind: "business_claim",
        text: "The warranty covers manufacturing defects for 12 months.",
        citations: [chunkId],
      }],
    }])
    const { url, close } = await startServer(provider)
    try {
      const first = await postChat(url, { tenantSlug: "budget-accumulate", message: "warranty" }, {
        origin: ALLOWED_ORIGIN,
      })
      expect(first.status).toBe(200)
      const firstJson = await first.json() as { kind: string }
      expect(firstJson.kind).toBe("answered")
      expect(provider.calls.length).toBe(1)

      const usageRows = await db.select({ costCents: usageEvents.costCents }).from(usageEvents)
        .where(eq(usageEvents.tenantId, accumulateTenantId))
      expect(usageRows.length).toBe(1)
      expect(usageRows[0]!.costCents).toBeGreaterThan(0)

      // The first answer's cost alone reached this tenant's one-cent budget, so a
      // second request — same tenant, a brand-new conversation — must be refused
      // without ever reaching the provider a second time.
      const second = await postChat(url, { tenantSlug: "budget-accumulate", message: "anything else" }, {
        origin: ALLOWED_ORIGIN,
      })
      expect(second.status).toBe(200)
      const secondJson = await second.json() as { kind: string; reason: string }
      expect(secondJson.kind).toBe("refused")
      expect(secondJson.reason).toBe("budget_exhausted")
      expect(provider.calls.length).toBe(1)
    } finally {
      await close()
    }
  })
})
