import type { AddressInfo } from "node:net"
import { FakeProvider } from "@quidchat/core/testing"
import {
  chunks, documents, knowledgeSources, messages, tenants, tenantSettings, type QuidDb,
} from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type ServerDeps } from "./server.js"

const ALLOWED_ORIGIN = "https://widget.example.test"
const WARRANTY_TEXT = "Our warranty covers manufacturing defects for 12 months from the date of purchase."

/** Seeds one tenant with a document, one chunk, and the given origin allowlist. */
async function seedTenant(
  db: QuidDb,
  args: { slug: string; allowedOrigins: string[]; chunkText?: string },
): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ slug: args.slug, name: args.slug }).returning()
  await db.insert(tenantSettings).values({
    tenantId: tenant!.id,
    allowedOrigins: args.allowedOrigins,
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
      const json = await res.json() as { kind: string; citedChunkIds: string[] }
      expect(json.kind).toBe("answered")
      expect(json.citedChunkIds.length).toBeGreaterThan(0)
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
})
