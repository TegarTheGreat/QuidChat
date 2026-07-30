import type { AddressInfo } from "node:net"
import { FakeProvider } from "@quidchat/core/testing"
import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "./server.js"

/**
 * The widget is pasted onto a business's own site, so every request it makes is cross-origin.
 * These assertions are the difference between a widget that works in a browser and one that only
 * ever worked from curl — which is what shipped until a browser was finally pointed at it.
 */

const SITE = "https://myshop.example"
let db: QuidDb
let baseUrl: string
let close: () => Promise<void>

beforeAll(async () => {
  db = await freshPglite()
  const [tenant] = await db.insert(tenants).values({ slug: "cors-shop", name: "Shop" }).returning()
  await db.insert(tenantSettings).values({ tenantId: tenant!.id, allowedOrigins: [SITE] })

  const server = createServer({ db, provider: new FakeProvider([]), logError: () => {} })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise<void>((resolve) => server.close(() => resolve()))
})

afterAll(async () => {
  await close()
})

describe("cross-origin access for the widget", () => {
  it("answers the preflight the chat POST requires", async () => {
    // `content-type: application/json` makes the request non-simple, so a browser preflights it
    // and sends nothing at all if that fails. This used to be a 405.
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "OPTIONS",
      headers: {
        origin: SITE,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE)
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type")
    // Without a max-age a browser preflights every single message, doubling requests on the one
    // route that costs money.
    expect(Number(res.headers.get("access-control-max-age"))).toBeGreaterThan(0)
  })

  it("lets the browser read an answer, a refusal and the widget config", async () => {
    for (const path of ["/v1/chat", "/v1/widget-config?tenantSlug=cors-shop", "/quidchat.js"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: path === "/v1/chat" ? "POST" : "GET",
        headers: { origin: SITE, "content-type": "application/json" },
        ...(path === "/v1/chat"
          ? { body: JSON.stringify({ tenantSlug: "cors-shop", message: "hi" }) }
          : {}),
      })
      expect(res.headers.get("access-control-allow-origin"), path).toBe(SITE)
      // Echoing the origin only means anything for caches if this is set too.
      expect(res.headers.get("vary"), path).toContain("Origin")
    }
  })

  it("still sends the header on a 403, so the widget can explain the mistake", async () => {
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: { origin: "https://not-allowed.example", "content-type": "application/json" },
      body: JSON.stringify({ tenantSlug: "cors-shop", message: "hi" }),
    })
    expect(res.status).toBe(403)
    // The allowlist is the access control, and it just refused. Withholding the CORS header as
    // well would hide the 403 and its message from the script, turning the most common setup
    // mistake into an unexplained failure.
    expect(res.headers.get("access-control-allow-origin")).toBe("https://not-allowed.example")
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("origin") })
  })

  it("does not open the admin API to other origins", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/tenants`, { headers: { origin: SITE } })
    // The panel is served by this same process, so it is same-origin and needs nothing. An admin
    // API readable from any page on the internet is a different thing to own.
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })
})
