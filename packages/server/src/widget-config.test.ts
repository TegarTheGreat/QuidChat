import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { cannedAnswers, tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { beforeAll, describe, expect, it } from "vitest"
import { handleWidgetConfig } from "./widget-config.js"

/**
 * Wires only `handleWidgetConfig` to `node:http`, standing in for the route
 * `server.ts` will mount at `/widget-config` (see the handler's doc comment). This
 * stays local to the test file, rather than going through `createServer`, precisely
 * because that route is intentionally not wired there yet.
 */
async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const tenantSlug = url.searchParams.get("tenantSlug") ?? ""
    handleWidgetConfig(res, db, tenantSlug).catch((e: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function seedTenant(
  db: QuidDb,
  slug: string,
  settings: Partial<typeof tenantSettings.$inferInsert> = {},
  canned: { question: string; answer: string; status: "draft" | "approved" }[] = [],
): Promise<void> {
  const [tenant] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: tenant!.id, ...settings })
  for (const row of canned) {
    await db.insert(cannedAnswers).values({ tenantId: tenant!.id, ...row })
  }
}

// One shared PGlite instance for every test below, each using its own uniquely-slugged
// tenant — see admin.test.ts's comment on why this sandbox cannot afford one instance
// per test.
let db: QuidDb

beforeAll(async () => {
  db = await freshPglite()
})

describe("GET /widget-config", () => {
  it("returns 404 with a JSON error for an unknown tenant slug", async () => {
    const { url, close } = await startServer()
    try {
      const res = await fetch(`${url}/?tenantSlug=does-not-exist`)
      expect(res.status).toBe(404)
      const json = await res.json() as { error: string }
      expect(json.error).toMatch(/unknown tenant/)
    } finally {
      await close()
    }
  })

  it("returns only the whitelisted presentation fields, never the refusal text, budget, or origins", async () => {
    await seedTenant(db, "widget-config-whitelist", {
      refusalText: "SECRET REFUSAL TEXT",
      monthlyBudgetCents: 123456,
      allowedOrigins: ["https://secret.example"],
      chatModel: "secret-internal-model",
      widgetTheme: { primaryColor: "#112233", position: "left", title: "Acme Support" },
    })
    const { url, close } = await startServer()
    try {
      const res = await fetch(`${url}/?tenantSlug=widget-config-whitelist`)
      expect(res.status).toBe(200)
      const body = await res.text()

      // An exact match on the whitelisted three fields is itself proof nothing else
      // came along for the ride, since `toEqual` fails on any extra key.
      expect(JSON.parse(body)).toEqual({
        primaryColor: "#112233",
        position: "left",
        title: "Acme Support",
      })
      // Checked again as a substring search on the raw body, so this test would still
      // catch a future change that spreads the row into some other field name instead
      // of adding a new top-level key.
      expect(body).not.toMatch(/SECRET REFUSAL TEXT|123456|secret\.example|secret-internal-model/)
    } finally {
      await close()
    }
  })

  it("drops keys inside widget_theme that are not part of the contract", async () => {
    // widget_theme is free-form jsonb an admin can write anything into, and this endpoint is
    // public. The exact-match test above cannot fail if the filter is removed, because the
    // query already selects nothing but widget_theme — so this is the case that actually holds
    // the whitelist in place: an internal note stored beside the colours must not be served to
    // every visitor of the site.
    await seedTenant(db, "widget-config-extra-keys", {
      widgetTheme: {
        primaryColor: "#112233",
        internalNote: "renewal negotiation, do not show",
        adminEmail: "owner@example.com",
      },
    })
    const { url, close } = await startServer()
    try {
      const res = await fetch(`${url}/?tenantSlug=widget-config-extra-keys`)
      const body = await res.text()
      // The title is the tenant's own name, filled in because this theme configures none — the
      // whitelist is what keeps the two keys beside it out.
      expect(JSON.parse(body)).toEqual({
        primaryColor: "#112233",
        title: "widget-config-extra-keys",
      })
      expect(body).not.toMatch(/renewal negotiation|owner@example\.com/)
    } finally {
      await close()
    }
  })
})

describe("opening questions", () => {
  it("offers the business's approved canned questions when nothing is configured", async () => {
    // Those already are the questions this business knows it gets, so a shop that has done that
    // setup gets openers with no further configuration — and tapping one cannot lead to a
    // refusal, because an approved answer exists for it.
    await seedTenant(db, "starters-default", {}, [
      { question: "Berapa lama garansinya?", answer: "12 bulan.", status: "approved" },
      { question: "Bisa retur?", answer: "7 hari.", status: "approved" },
    ])
    const server = await startServer()
    try {
      const res = await fetch(`${server.url}/widget-config?tenantSlug=starters-default`)
      const body = (await res.json()) as { starters?: string[] }
      expect(body.starters).toEqual(["Berapa lama garansinya?", "Bisa retur?"])
    } finally {
      await server.close()
    }
  })

  it("never offers a draft question", async () => {
    // A draft is text nobody has agreed to show a customer. On the opening screen it would be
    // shown to every one of them.
    await seedTenant(db, "starters-draft", {}, [
      { question: "Approved one", answer: "a", status: "approved" },
      { question: "Unreviewed draft", answer: "b", status: "draft" },
    ])
    const server = await startServer()
    try {
      const res = await fetch(`${server.url}/widget-config?tenantSlug=starters-draft`)
      const body = (await res.json()) as { starters?: string[] }
      expect(body.starters).toEqual(["Approved one"])
    } finally {
      await server.close()
    }
  })

  it("lets an explicit list win over the canned defaults", async () => {
    await seedTenant(
      db,
      "starters-explicit",
      { widgetTheme: { starters: ["Jam buka?", "Alamat toko?"] } },
      [{ question: "Ignored", answer: "x", status: "approved" }],
    )
    const server = await startServer()
    try {
      const res = await fetch(`${server.url}/widget-config?tenantSlug=starters-explicit`)
      const body = (await res.json()) as { starters?: string[] }
      expect(body.starters).toEqual(["Jam buka?", "Alamat toko?"])
    } finally {
      await server.close()
    }
  })

  it("names the business in the header when no title was configured", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug: "title-default", name: "Toko Berkah" })
      .returning()
    await db.insert(tenantSettings).values({ tenantId: tenant!.id })
    const server = await startServer()
    try {
      const res = await fetch(`${server.url}/widget-config?tenantSlug=title-default`)
      const body = (await res.json()) as Record<string, unknown>
      // It read "Chat assistant" on every site whose owner never opened the theme editor, which
      // tells a customer nothing and reads like software bolted onto the page.
      expect(body.title).toBe("Toko Berkah")
    } finally {
      await server.close()
    }
  })

  it("lets a configured title win over the business's name", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug: "title-explicit", name: "PT Sumber Rejeki Abadi" })
      .returning()
    await db
      .insert(tenantSettings)
      .values({ tenantId: tenant!.id, widgetTheme: { title: "Bantuan Sumber Rejeki" } })
    const server = await startServer()
    try {
      const res = await fetch(`${server.url}/widget-config?tenantSlug=title-explicit`)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.title).toBe("Bantuan Sumber Rejeki")
    } finally {
      await server.close()
    }
  })

  it("says nothing at all when a tenant has neither", async () => {
    await seedTenant(db, "starters-none")
    const server = await startServer()
    try {
      const res = await fetch(`${server.url}/widget-config?tenantSlug=starters-none`)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.starters).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
