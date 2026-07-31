import type { AddressInfo } from "node:net"
import { FakeProvider } from "@quidchat/core/testing"
import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "./server.js"

/**
 * Pausing a channel has to stop it, not just relabel it.
 *
 * The panel drew a "Paused" badge from an `enabled` flag that the webhook read as part of its
 * lookup: `WHERE channel = ? AND enabled = true`. A paused row therefore looked exactly like no
 * row at all, and the handler fell through to the environment — so on the ordinary deployment,
 * where the bot token is an environment variable anyway, pausing WhatsApp changed a badge and
 * nothing else. The bot went on answering customers while its owner believed it had stopped.
 *
 * A real server with a real token in its environment is the only place that shows this: with no
 * environment credential the old code returned 404 and looked correct.
 */

let db: QuidDb
let baseUrl: string
let close: () => Promise<void>

const ADMIN_TOKEN = "pause-token"
const UPDATE = JSON.stringify({ update_id: 1 })
const SECRET = "shared-webhook-secret"

async function admin(method: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/admin/channels`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  })
}

/** An update with no message: verified, acknowledged, and answered by nobody — so this measures
 *  the webhook's decision to accept or refuse without a provider call or an outbound send. */
async function deliver(): Promise<number> {
  const res = await fetch(`${baseUrl}/v1/channels/telegram/paused-shop`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Telegram's own proof that the request came from Telegram. Stored and environment
      // credentials share one value here so that a delivery stays valid across both.
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: UPDATE,
  })
  await res.text()
  return res.status
}

beforeAll(async () => {
  db = await freshPglite()
  // The settings row is what makes a tenant resolvable — the webhook joins the two.
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: "paused-shop", name: "Paused Shop" })
    .returning()
  await db.insert(tenantSettings).values({ tenantId: tenant!.id, allowedOrigins: [] })

  const server = createServer({
    db,
    provider: new FakeProvider([]),
    logError: () => {},
    env: {
      QUIDCHAT_ADMIN_TOKEN: ADMIN_TOKEN,
      QUIDCHAT_SECRET_KEY: Buffer.alloc(32, 5).toString("base64"),
      // The deployment's own bot, exactly as a one-shop install has it.
      TELEGRAM_BOT_TOKEN: "111:env-token",
      TELEGRAM_SECRET_TOKEN: SECRET,
    },
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise<void>((resolve) => server.close(() => resolve()))
})

afterAll(async () => {
  await close()
})

describe("pausing a channel", () => {
  it("stops the webhook even when the server has its own token", async () => {
    expect(await deliver()).toBe(200)

    const connected = await admin("PUT", {
      tenantSlug: "paused-shop",
      channel: "telegram",
      enabled: true,
      secrets: { botToken: "222:tenant-token", secretToken: SECRET },
    })
    expect(connected.status).toBe(200)
    expect(await deliver()).toBe(200)

    const paused = await admin("PATCH", {
      tenantSlug: "paused-shop",
      channel: "telegram",
      enabled: false,
    })
    expect(paused.status).toBe(200)
    expect(await paused.json()).toMatchObject({ channel: "telegram", enabled: false })

    // The assertion the old code failed: with TELEGRAM_BOT_TOKEN in the environment it answered
    // this as though nothing had been paused.
    expect(await deliver()).toBe(403)
  })

  it("resumes without the token being supplied again", async () => {
    // The reason a separate route exists. Saving goes through a whole-row replace, so resuming
    // through it would demand the credential a second time — at the moment an owner is least
    // able to find it.
    const resumed = await admin("PATCH", {
      tenantSlug: "paused-shop",
      channel: "telegram",
      enabled: true,
    })
    expect(resumed.status).toBe(200)
    expect(await deliver()).toBe(200)
  })

  it("refuses to pause a channel that was never connected", async () => {
    const res = await admin("PATCH", {
      tenantSlug: "paused-shop",
      channel: "discord",
      enabled: false,
    })
    // An owner who sees "paused" on a channel that is not connected would trust a protection
    // that does not exist.
    expect(res.status).toBe(404)
  })
})
