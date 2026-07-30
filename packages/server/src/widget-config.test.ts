import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
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
): Promise<void> {
  const [tenant] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: tenant!.id, ...settings })
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
      expect(JSON.parse(body)).toEqual({ primaryColor: "#112233" })
      expect(body).not.toMatch(/renewal negotiation|owner@example\.com/)
    } finally {
      await close()
    }
  })
})
