import type { IncomingMessage, ServerResponse } from "node:http"
import type { Provider, Store } from "@quidchat/core"
import { answer } from "@quidchat/core"
import {
  discordAdapter,
  handleChannelMessage,
  isDiscordPing,
  telegramAdapter,
  wahaAdapter,
  whatsappCloudAdapter,
  type ChannelAdapter,
} from "@quidchat/channels"
import { sql } from "drizzle-orm"
import { withTenant, type QuidDb } from "@quidchat/db"
import { lookupTenantBySlug } from "./tenant-lookup.js"
import { notifyEscalationInBackground } from "./escalation-notify.js"
import type { ChatRateLimiter } from "./rate-limit.js"

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export type ChannelDeps = {
  db: QuidDb
  provider: Provider
  store: Store
  env: Record<string, string | undefined>
  logError: (message: string, cause: unknown) => void
  /** The same limiter the web routes use. A customer spamming a Telegram bot spends the
   *  tenant's budget exactly as fast as one spamming the widget. */
  rateLimiter: ChatRateLimiter
}

/**
 * Builds the adapter for a channel from the environment, or null when it is not
 * configured.
 *
 * Each channel is opt-in: a business that only uses the website widget should not have a
 * live WhatsApp webhook sitting unauthenticated on its server. Absent credentials mean the
 * route returns `404`, which is the honest answer — the endpoint genuinely is not there.
 *
 * The tenant slug comes from the URL rather than the environment, so one deployment can
 * serve many businesses on the same bot. That is also why the credentials are per-channel
 * and not per-tenant for now: sharing one bot across tenants is the common small-scale
 * shape, and per-tenant credentials belong in the admin panel where a business can enter
 * their own.
 */
function adapterFor(
  channel: string,
  tenantSlug: string,
  env: Record<string, string | undefined>,
): ChannelAdapter | null {
  switch (channel) {
    case "telegram": {
      const botToken = env.TELEGRAM_BOT_TOKEN
      if (!botToken) return null
      return telegramAdapter({
        tenantSlug,
        botToken,
        ...(env.TELEGRAM_SECRET_TOKEN ? { secretToken: env.TELEGRAM_SECRET_TOKEN } : {}),
      })
    }
    case "whatsapp": {
      const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID
      const accessToken = env.WHATSAPP_ACCESS_TOKEN
      if (!phoneNumberId || !accessToken) return null
      return whatsappCloudAdapter({
        tenantSlug,
        phoneNumberId,
        accessToken,
        ...(env.WHATSAPP_APP_SECRET ? { appSecret: env.WHATSAPP_APP_SECRET } : {}),
      })
    }
    case "waha": {
      const baseUrl = env.WAHA_BASE_URL
      if (!baseUrl) return null
      return wahaAdapter({
        tenantSlug,
        baseUrl,
        ...(env.WAHA_SESSION ? { session: env.WAHA_SESSION } : {}),
        ...(env.WAHA_API_KEY ? { apiKey: env.WAHA_API_KEY } : {}),
      })
    }
    case "discord": {
      const botToken = env.DISCORD_BOT_TOKEN
      if (!botToken) return null
      return discordAdapter({
        tenantSlug,
        botToken,
        ...(env.DISCORD_PUBLIC_KEY ? { publicKey: env.DISCORD_PUBLIC_KEY } : {}),
      })
    }
    default:
      return null
  }
}

/** Reads the whole body as a string, bounded. The raw bytes are needed for signature
 *  verification, so this cannot parse as it goes. */
async function readRawBody(req: IncomingMessage, limit = 256_000): Promise<string | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // Bounded while reading, not after. An unbounded read is a denial of service that
    // takes no skill to perform.
    if (size > limit) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Finds or creates the conversation for this visitor on this channel. */
async function conversationFor(
  db: QuidDb,
  tenantId: string,
  channel: string,
  visitorId: string,
): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const existing = rowsOf(
      await tx.execute(sql`
        SELECT id FROM conversations
        WHERE channel = ${channel} AND visitor_id = ${visitorId}
        ORDER BY created_at DESC
        LIMIT 1
      `),
    )[0]
    if (existing) return existing.id as string

    const created = rowsOf(
      await tx.execute(sql`
        INSERT INTO conversations (tenant_id, channel, visitor_id)
        VALUES (${tenantId}, ${channel}, ${visitorId})
        RETURNING id
      `),
    )[0]
    return created!.id as string
  })
}

/** The stored transcript, oldest first, so a follow-up question has context. */
async function historyFor(
  db: QuidDb,
  tenantId: string,
  conversationId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = rowsOf(
      await tx.execute(sql`
        SELECT role, content FROM messages
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at ASC
      `),
    )
    return rows.map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content as string,
    }))
  })
}

/**
 * `POST /channels/:channel/:tenantSlug`
 *
 * Always answers `200` once the request is genuine, even when the pipeline refused or
 * delivery failed. Every one of these platforms retries a non-2xx webhook, and a retry
 * would re-answer a question that was already answered and recorded — billing twice and
 * sending the customer a duplicate. The only non-2xx responses are for requests that
 * should never be processed at all: an unknown channel, an unknown tenant, a body that is
 * too large, or a failed signature.
 */
export async function handleChannelWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ChannelDeps,
): Promise<void> {
  const parts = pathname.split("/").filter(Boolean) // ["channels", channel, slug]
  const channel = parts[1]
  const tenantSlug = parts[2]

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "method not allowed" }))
    return
  }
  if (!channel || !tenantSlug) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "expected /channels/:channel/:tenantSlug" }))
    return
  }

  const adapter = adapterFor(channel, tenantSlug, deps.env)
  if (!adapter) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: `channel "${channel}" is not configured` }))
    return
  }

  const rawBody = await readRawBody(req)
  if (rawBody === null) {
    res.writeHead(413, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "request body too large" }))
    return
  }

  // Discord disables an endpoint that does not answer its PING with type 1, and the ping
  // carries no tenant, so it is handled before anything else.
  if (channel === "discord") {
    try {
      if (isDiscordPing(JSON.parse(rawBody))) {
        if (adapter.verify && !adapter.verify({ body: rawBody, headers: req.headers })) {
          res.writeHead(401).end()
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ type: 1 }))
        return
      }
    } catch {
      // Not JSON — fall through and let the shared handler reject it.
    }
  }

  const identity = await lookupTenantBySlug(deps.db, tenantSlug)
  if (!identity) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "unknown tenant" }))
    return
  }

  try {
    const result = await handleChannelMessage({
      adapter,
      rawBody,
      headers: req.headers,
      logError: deps.logError,
      answer: async (incoming) => {
        // Checked here rather than before parsing, because the visitor is only known once
        // the payload has been verified and parsed — and a per-tenant limit alone would let
        // one abusive customer refuse every other customer of that business.
        //
        // A rate-limited message is answered with the tenant's own refusal text instead of a
        // non-2xx status: every one of these platforms retries a failed webhook, so an error
        // here would come straight back and the limit would never actually hold.
        const decision = deps.rateLimiter.check({
          tenantId: identity.tenantId,
          visitorId: incoming.visitorId,
        })
        if (!decision.allowed) {
          const config = await deps.store.getTenantConfig(identity.tenantId)
          return { kind: "refused", text: config.refusalText, reason: "rate_limited" }
        }

        const conversationId = await conversationFor(
          deps.db,
          identity.tenantId,
          adapter.id,
          incoming.visitorId,
        )
        const history = await historyFor(deps.db, identity.tenantId, conversationId)
        const outcome = await answer({
          store: deps.store,
          provider: deps.provider,
          tenantId: identity.tenantId,
          conversationId,
          history,
          question: incoming.text,
        })
        if (outcome.kind === "refused") {
          // Same signal as on the web, and the channel is carried through so the business can
          // tell a WhatsApp customer waiting on them from a website visitor.
          notifyEscalationInBackground({
            db: deps.db,
            notice: {
              tenantId: identity.tenantId, conversationId, question: incoming.text,
              reason: outcome.reason, channel: adapter.id,
            },
            logError: deps.logError,
          })
        }

        return outcome.kind === "answered"
          ? {
              kind: "answered",
              segments: outcome.segments,
              citations: outcome.citations,
            }
          : { kind: "refused", text: outcome.text, reason: outcome.reason }
      },
    })

    if (result.status === "rejected") {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: result.why }))
      return
    }

    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: result.status }))
  } catch (cause) {
    // A store or provider failure. Logged operationally, never recorded as an escalation —
    // see the reasoning on `answer()`. Still a 200, because the platform must not retry a
    // request whose failure will repeat.
    deps.logError(`${channel} webhook failed`, cause)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "error" }))
  }
}
