import type { AddressInfo } from "node:net"
import { FakeProvider } from "@quidchat/core/testing"
import { chunks, tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { createServer, type ServerDeps } from "./server.js"

const ADMIN_TOKEN = "test-admin-token"

/** Starts a server with the given deps and returns its base URL plus a closer. */
async function startServer(deps: ServerDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(deps)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function seedTenant(db: QuidDb, slug: string, allowedOrigins: string[] = []): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: tenant!.id, allowedOrigins })
  return tenant!.id
}

// A single PGlite instance shared by every test below, each of which uses its own
// uniquely-slugged tenant and its own `node:http` server (bound to its own OS-assigned
// port). One shared database — rather than one per test — matters in THIS sandbox: it
// is shared with several other agents' concurrent builds and test runs, and each
// PGlite/WASM instance plus its migrations is expensive enough that a handful of them
// running at once has been observed to exhaust memory and kill the test worker outright
// (see the root `vitest.config.ts`'s note on `fileParallelism` for the same lesson
// learned about running database test FILES in parallel).
let db: QuidDb

beforeAll(async () => {
  db = await freshPglite()
})

describe("admin authentication", () => {
  it("returns 401 for an admin route with a missing or wrong bearer token", async () => {
    const { url, close } = await startServer({
      db, provider: new FakeProvider([]), logError: () => {},
      env: { QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN },
    })
    try {
      const noHeader = await fetch(`${url}/admin/tenants`)
      expect(noHeader.status).toBe(401)

      const wrongToken = await fetch(`${url}/admin/tenants`, {
        headers: { authorization: "Bearer wrong-token" },
      })
      expect(wrongToken.status).toBe(401)
    } finally {
      await close()
    }
  })

  it("returns 503 for every admin route when QUIDCHAT_ADMIN_TOKEN is unset, rather than defaulting to open", async () => {
    // `env: {}` — deliberately no `QUIDCHAT_ADMIN_TOKEN` key at all, not an empty string.
    const { url, close } = await startServer({
      db, provider: new FakeProvider([]), logError: () => {}, env: {},
    })
    try {
      const res = await fetch(`${url}/admin/tenants`, {
        headers: { authorization: "Bearer anything" },
      })
      expect(res.status).toBe(503)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/QUIDCHAT_ADMIN_TOKEN/)
    } finally {
      await close()
    }
  })
})

describe("PATCH /admin/settings", () => {
  it("rejects an unknown settings column with 400, rather than writing it", async () => {
    await seedTenant(db, "settings-unknown-column")
    const { url, close } = await startServer({
      db, provider: new FakeProvider([]), logError: () => {},
      env: { QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN },
    })
    try {
      const res = await fetch(`${url}/admin/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ tenantSlug: "settings-unknown-column", not_a_real_column: "value" }),
      })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/not_a_real_column/)
    } finally {
      await close()
    }
  })

  it("updates an allowlisted column, e.g. monthly_budget_cents", async () => {
    await seedTenant(db, "settings-known-column")
    const { url, close } = await startServer({
      db, provider: new FakeProvider([]), logError: () => {},
      env: { QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN },
    })
    try {
      const res = await fetch(`${url}/admin/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ tenantSlug: "settings-known-column", monthly_budget_cents: 500 }),
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { monthly_budget_cents: number }
      expect(json.monthly_budget_cents).toBe(500)
    } finally {
      await close()
    }
  })
})

describe("POST /admin/sources/text", () => {
  it("indexes a text source so its content is retrievable through /chat right afterward", async () => {
    const allowedOrigin = "https://widget.example.test"
    await seedTenant(db, "sources-text", [allowedOrigin])

    // A server whose provider only ever needs to `embed` — indexing a text source
    // never calls `complete`, so no canned answer is needed here at all.
    const writer = await startServer({
      db, provider: new FakeProvider([]), logError: () => {},
      env: { QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN },
    })
    let documentId: string
    try {
      const createRes = await fetch(`${writer.url}/admin/sources/text`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({
          tenantSlug: "sources-text",
          title: "Warranty Policy",
          text: "Our warranty covers manufacturing defects for 12 months from purchase.",
        }),
      })
      expect(createRes.status).toBe(201)
      const created = await createRes.json() as { status: string; documentId: string }
      expect(created.status).toBe("ready")
      documentId = created.documentId
    } finally {
      await writer.close()
    }

    // The real chunk id indexing just created, needed to build a canned answer whose
    // citation the grounding validator will actually accept — a placeholder id would
    // fail validation, which is exactly the point: this proves the indexed content is
    // genuinely the thing `/chat` finds and cites, not merely that a row exists.
    const [chunk] = await db.select({ id: chunks.id }).from(chunks)
      .where(eq(chunks.documentId, documentId))
    const provider = new FakeProvider([{
      segments: [{
        kind: "business_claim",
        text: "Our warranty covers manufacturing defects for 12 months.",
        citations: [chunk!.id],
      }],
    }])
    const reader = await startServer({ db, provider, logError: () => {} })
    try {
      const chatRes = await fetch(`${reader.url}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: allowedOrigin },
        body: JSON.stringify({ tenantSlug: "sources-text", message: "warranty" }),
      })
      expect(chatRes.status).toBe(200)
      const chatJson = await chatRes.json() as {
        kind: string
        citations: { chunkId: string; documentTitle: string }[]
      }
      expect(chatJson.kind).toBe("answered")
      expect(chatJson.citations.length).toBeGreaterThan(0)
      expect(chatJson.citations[0]!.documentTitle).toBe("Warranty Policy")
    } finally {
      await reader.close()
    }
  })
})

describe("GET /quidchat.js", () => {
  it("serves the built widget bundle as JavaScript", async () => {
    const { url, close } = await startServer({ db, provider: new FakeProvider([]), logError: () => {} })
    try {
      const res = await fetch(`${url}/quidchat.js`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toMatch(/javascript/)
      const body = await res.text()
      expect(body.length).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })
})

describe("/v1 prefix", () => {
  it("answers /v1/chat identically to /chat, and /v1/admin/... identically to /admin/...", async () => {
    const allowedOrigin = "https://widget.example.test"
    await seedTenant(db, "v1-prefix", [allowedOrigin])

    const { url, close } = await startServer({
      db, provider: new FakeProvider([]), logError: () => {},
      env: { QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN },
    })
    try {
      // No knowledge base was seeded for this tenant, so both paths take the
      // deterministic `no_source` refusal — reached before the provider is ever
      // touched — which makes an exact equality assertion possible without any
      // canned answer.
      const unprefixed = await fetch(`${url}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: allowedOrigin },
        body: JSON.stringify({ tenantSlug: "v1-prefix", message: "hi there" }),
      })
      const prefixed = await fetch(`${url}/v1/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: allowedOrigin },
        body: JSON.stringify({ tenantSlug: "v1-prefix", message: "hi there" }),
      })
      expect(prefixed.status).toBe(unprefixed.status)
      expect(prefixed.status).toBe(200)
      const unprefixedJson = await unprefixed.json() as { kind: string; reason: string }
      const prefixedJson = await prefixed.json() as { kind: string; reason: string }
      expect(prefixedJson.kind).toBe(unprefixedJson.kind)
      expect(prefixedJson.reason).toBe(unprefixedJson.reason)
      expect(prefixedJson.kind).toBe("refused")
      expect(prefixedJson.reason).toBe("no_source")

      const unprefixedAdmin = await fetch(`${url}/admin/tenants`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
      const prefixedAdmin = await fetch(`${url}/v1/admin/tenants`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
      expect(prefixedAdmin.status).toBe(200)
      expect(prefixedAdmin.status).toBe(unprefixedAdmin.status)
      expect(await prefixedAdmin.json()).toEqual(await unprefixedAdmin.json())
    } finally {
      await close()
    }
  })
})
