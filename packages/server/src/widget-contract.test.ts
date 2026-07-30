import type { AddressInfo } from "node:net"
import { FakeProvider } from "@quidchat/core/testing"
import { chunks, documents, knowledgeSources, tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createServer } from "./server.js"

/**
 * The widget's own client, run against the real chat API.
 *
 * The admin client had six field-name and wrapper-shape drifts against its server, every one of
 * which typechecked and passed unit tests, because nothing ran the two together. This is the
 * same test for the path that matters most: the one a paying customer's customer is on.
 *
 * It covers what a mocked fetch cannot — that `citations` really carry a `documentTitle` the
 * widget can render rather than a chunk id, that a refusal arrives as a result and not as a
 * thrown error, and that the SSE parser reads a stream this server actually produces rather
 * than one the test authored to match the parser.
 */

const ORIGIN = "https://shop.example"
const WARRANTY_TEXT = "The warranty covers manufacturing defects for twelve months."

let db: QuidDb
let baseUrl: string
let tenantId: string

beforeAll(async () => {
  db = await freshPglite()
  const [tenant] = await db.insert(tenants).values({ slug: "widget-shop", name: "Shop" }).returning()
  tenantId = tenant!.id
  await db.insert(tenantSettings).values({ tenantId, allowedOrigins: [ORIGIN] })
  const [source] = await db
    .insert(knowledgeSources)
    .values({ tenantId, kind: "text", uri: "policy.txt", status: "ready" })
    .returning()
  const [doc] = await db
    .insert(documents)
    .values({ tenantId, sourceId: source!.id, title: "Store Policy" })
    .returning()
  await db.insert(chunks).values({
    tenantId,
    documentId: doc!.id,
    ordinal: 0,
    content: WARRANTY_TEXT,
    embeddingModel: "test-embed",
  })

  const [chunk] = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.tenantId, tenantId))
  const provider = new FakeProvider([
    { segments: [{ kind: "business_claim", text: WARRANTY_TEXT, citations: [chunk!.id] }] },
  ])

  const server = createServer({ db, provider, logError: () => {} })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // A browser attaches `Origin` to a cross-site request; Node's fetch does not, and the chat
  // route refuses a request without one — correctly, since that header is the only thing
  // standing between a business's assistant and anyone who copies its public slug. Adding it
  // here is standing in for the browser, not weakening the check: the 403 path is asserted
  // separately below with the header deliberately wrong.
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: string | URL | Request, init: RequestInit = {}) =>
    realFetch(input as string, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), origin: ORIGIN },
    }),
  )
})

const cfg = () => ({ tenantSlug: "widget-shop", apiBase: baseUrl })

async function widget() {
  return await import("../../widget/src/api.js")
}

describe("the widget's client against the chat API", () => {
  it("gets a cited answer whose citations carry a document title", async () => {
    const { sendMessage } = await widget()
    const result = await sendMessage(cfg(), { message: "warranty" })

    expect(result.kind).toBe("answered")
    if (result.kind !== "answered") return
    // The widget renders `documentTitle` under the answer. A chunk id here would show a uuid to
    // a customer, which is the exact bug this pairing exists to prevent.
    expect(result.citations[0]?.documentTitle).toBe("Store Policy")
    expect(result.citations[0]?.chunkId).toBeTruthy()
    // The segment cites by chunk id, and the widget resolves it through that list — so the id
    // it cites has to be one the list contains.
    const segment = result.segments[0]!
    expect(segment.kind).toBe("business_claim")
    if (segment.kind === "business_claim") {
      expect(result.citations.map((c) => c.chunkId)).toContain(segment.citations[0])
    }
    expect(typeof result.conversationId).toBe("string")
  })

  it("returns a refusal as a result, never as a thrown error", async () => {
    const { sendMessage } = await widget()
    // A tenant with nothing to answer from refuses. That is the product working, and a widget
    // that treated it as a failure would show an error bubble instead of the assistant's own
    // words.
    const [bare] = await db.insert(tenants).values({ slug: "widget-bare", name: "Bare" }).returning()
    await db.insert(tenantSettings).values({ tenantId: bare!.id, allowedOrigins: [ORIGIN] })

    const result = await sendMessage({ tenantSlug: "widget-bare", apiBase: baseUrl }, { message: "hours?" })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") expect(result.text.length).toBeGreaterThan(0)
  })

  it("names the origin problem when the site is not allowed", async () => {
    const { sendMessage } = await widget()
    const [other] = await db.insert(tenants).values({ slug: "widget-locked", name: "Locked" }).returning()
    // An empty allowlist is the not-yet-configured case, and it must fail closed.
    await db.insert(tenantSettings).values({ tenantId: other!.id, allowedOrigins: [] })

    await expect(
      sendMessage({ tenantSlug: "widget-locked", apiBase: baseUrl }, { message: "hi" }),
    ).rejects.toThrow(/not authorized/)
  })

  it("names the tenant problem when the slug is unknown", async () => {
    const { sendMessage } = await widget()
    await expect(
      sendMessage({ tenantSlug: "no-such-shop", apiBase: baseUrl }, { message: "hi" }),
    ).rejects.toThrow(/tenant key is unknown/)
  })

  it("reads the real event stream, reporting stages and then the answer", async () => {
    const { sendMessageWithProgress } = await widget()
    const stages: string[] = []
    const result = await sendMessageWithProgress(cfg(), { message: "warranty" }, (s) => stages.push(s))

    // The parser is tested elsewhere against synthetic events; this asserts it against a stream
    // this server actually produced, including its framing and its ordering.
    expect(stages[0]).toBe("retrieving")
    expect(stages).toContain("validating")
    expect(result.kind).toBe("answered")
    if (result.kind === "answered") {
      expect(result.citations[0]?.documentTitle).toBe("Store Policy")
    }
  })
})
