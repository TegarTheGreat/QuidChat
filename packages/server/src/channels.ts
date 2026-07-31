import type { IncomingMessage, ServerResponse } from "node:http"
import type { Provider, Store } from "@quidchat/core"
import {
  adapterFromEnv,
  adapterFromStoredSecrets,
  handleChannelMessage,
  isDiscordPing,
  slackChallenge,
} from "@quidchat/channels"
import { sql } from "drizzle-orm"
import { withTenant, type QuidDb } from "@quidchat/db"
import { answerTurn } from "./answer-turn.js"
import type { ProviderResolver } from "./tenant-provider.js"
import { lookupTenantBySlug } from "./tenant-lookup.js"
import { decryptSecrets, readSecretKey } from "./secrets.js"
import type { ChatRateLimiter } from "./rate-limit.js"

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export type ChannelDeps = {
  db: QuidDb
  provider: Provider
  /** Builds a provider from a tenant's own credentials — see `tenant-provider.ts`. */
  resolveProvider?: ProviderResolver
  store: Store
  env: Record<string, string | undefined>
  logError: (message: string, cause: unknown) => void
  /** The same limiter the web routes use. A customer spamming a Telegram bot spends the
   *  tenant's budget exactly as fast as one spamming the widget. */
  rateLimiter: ChatRateLimiter
}

/**
 * The tenant's own channel credentials — or the fact that it has deliberately paused this one.
 *
 * Read before the environment is consulted, so a business that connected WhatsApp in the panel
 * uses its own number even on a deployment that also has one configured in the environment.
 * Without that precedence, a shared installation would answer every tenant's customers from one
 * account — which is the exact thing per-tenant credentials exist to prevent.
 *
 * "Paused" is a separate answer from "nothing stored", and that distinction is the whole point.
 * The row used to be selected with `AND enabled = true`, so a paused channel looked identical to
 * an unconfigured one and the caller fell through to the environment: on the ordinary small
 * deployment, where the token is in the environment anyway, pausing changed a badge in the panel
 * and nothing else. The bot kept answering customers while its owner believed it had stopped.
 *
 * Returns `none` on ANY failure, including a missing or changed encryption key, and the caller
 * falls back to the environment. A channel that stops working is visible in the panel, which
 * reports the same decryption failure; refusing the webhook outright would take a working
 * environment-configured channel down with it.
 */
type StoredChannel =
  | { kind: "secrets"; secrets: Record<string, string> }
  /** Configured, and switched off on purpose. Never falls back to the environment. */
  | { kind: "paused" }
  | { kind: "none" }

async function storedChannelSecrets(args: {
  db: QuidDb
  tenantId: string
  channel: string
  env: Record<string, string | undefined>
  logError: (message: string, cause: unknown) => void
}): Promise<StoredChannel> {
  const { db, tenantId, channel, env, logError } = args
  try {
    const row = await withTenant(db, tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT secrets, enabled FROM channel_configs WHERE channel = ${channel}
        `),
      )[0],
    )
    if (!row) return { kind: "none" }
    if (row.enabled === false) return { kind: "paused" }
    const secrets = decryptSecrets(row.secrets as string, readSecretKey(env), `${channel} credentials`)
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") out[key] = value
    }
    return Object.keys(out).length > 0 ? { kind: "secrets", secrets: out } : { kind: "none" }
  } catch (cause) {
    logError(`could not read stored ${channel} credentials`, cause)
    return { kind: "none" }
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

/** How many past messages travel with a question. See the identical bound in `chat.ts`: every
 *  message used to go into every prompt, so a long conversation grew its own cost each turn. */
const MAX_HISTORY_MESSAGES = 20

/** The recent transcript, oldest first, so a follow-up question has context. */
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
        ORDER BY created_at DESC, id DESC
        LIMIT ${MAX_HISTORY_MESSAGES}
      `),
    )
    return rows.toReversed().map((r) => ({
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

  const rawBody = await readRawBody(req)
  if (rawBody === null) {
    res.writeHead(413, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "request body too large" }))
    return
  }

  // The tenant is resolved before the adapter now, because the adapter may be built from
  // credentials that belong to the tenant. That moves the unknown-tenant 404 ahead of Discord's
  // PING handshake, which is the honest order: a ping to a slug that does not exist should not
  // be answered as though it did.
  const identity = await lookupTenantBySlug(deps.db, tenantSlug)
  if (!identity) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "unknown tenant" }))
    return
  }

  // Stored credentials first, the environment second. On a shared installation an environment
  // variable is one bot for everyone; a business that connected its own account in the panel
  // must talk to its own customers from its own number, or the feature is decorative.
  const stored = await storedChannelSecrets({
    db: deps.db,
    tenantId: identity.tenantId,
    channel,
    env: deps.env,
    logError: deps.logError,
  })
  if (stored.kind === "paused") {
    // 403, not 404: the channel exists and the platform's URL is correct, so an owner reading
    // their delivery log sees "switched off here" rather than hunting a webhook that looks wrong.
    res.writeHead(403, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: `channel "${channel}" is paused for this tenant` }))
    return
  }
  const adapter =
    (stored.kind === "secrets"
      ? adapterFromStoredSecrets(channel, tenantSlug, stored.secrets)
      : null) ?? adapterFromEnv(channel, tenantSlug, deps.env)
  if (!adapter) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: `channel "${channel}" is not configured` }))
    return
  }

  // Slack disables an endpoint that does not echo its challenge, exactly as Discord does with
  // its PING. Answered before the tenant matters, and only once the signature checks out — an
  // unverified handshake is still an unverified request.
  if (channel === "slack") {
    try {
      const challenge = slackChallenge(JSON.parse(rawBody))
      if (challenge !== null) {
        if (adapter.verify && !adapter.verify({ body: rawBody, headers: req.headers })) {
          res.writeHead(401).end()
          return
        }
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(challenge)
        return
      }
    } catch {
      // Not JSON — the shared handler rejects it.
    }
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
        // `answerTurn`, not `answer`: it carries the budget guard and the usage recording that
        // this path used to skip entirely — see the note on that function.
        const outcome = await answerTurn({
          db: deps.db,
          store: deps.store,
          provider: deps.provider,
          tenantId: identity.tenantId,
          conversationId,
          history,
          question: incoming.text,
          channel: adapter.id,
          logError: deps.logError,
          ...(deps.env ? { env: deps.env } : {}),
          ...(deps.resolveProvider ? { resolveProvider: deps.resolveProvider } : {}),
        })
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
