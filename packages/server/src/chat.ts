import type { IncomingMessage, ServerResponse } from "node:http"
import { answer, type Provider, type Store } from "@quidchat/core"
import { withTenant, type QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"
import { monthlyBudgetCents, recordUsage, spentThisMonthCents } from "./budget.js"
import { lookupTenantBySlug } from "./tenant-lookup.js"
import { openEventStream, sendProgress, sendResult, sendStreamError } from "./stream.js"
import { notifyEscalationInBackground } from "./escalation-notify.js"
import type { ChatRateLimiter } from "./rate-limit.js"

/** Normalizes the `execute()` result, whose shape differs between drivers — see the
 *  identical helper in `tenant-lookup.ts` and `@quidchat/db`'s `store.ts`. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * Applied while READING the body, not after it has already been buffered in full —
 * an unbounded read is a denial-of-service that requires no attacker skill at all.
 */
const MAX_BODY_BYTES = 16 * 1024
const MAX_MESSAGE_LENGTH = 4_000

/** Shape of the JSON body a visitor's widget sends. */
export type ChatRequest = {
  /** Public site slug, shipped in the page. Not a secret. */
  tenantSlug: string
  /** Absent on the first message of a conversation. */
  conversationId?: string
  message: string
}

export type ChatDeps = {
  db: QuidDb
  store: Store
  provider: Provider
  logError: (message: string, cause: unknown) => void
  /** Shared across every route so one client cannot get a fresh allowance by switching
   *  between the streaming and non-streaming endpoints. */
  rateLimiter: ChatRateLimiter
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/**
 * Reads the body up to `MAX_BODY_BYTES`. Resolves `null` the instant the bound is
 * crossed and stops consuming the socket right there — the bound has to act while
 * the bytes are still arriving, since waiting for `end` to check the total means the
 * unbounded buffer already happened.
 */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}

/**
 * Removes the one character Postgres will not store in a `text` column.
 *
 * A NUL byte reaching the database throws, and the visitor gets a 503 for a message that would
 * never work no matter how many times they tried. Stripped rather than rejected: a NUL in a
 * customer's question is an artifact of a paste or a broken client, never something they meant
 * to type, so answering the rest of their sentence is better than refusing all of it.
 */
function stripNulls(text: string): string {
  return text.replaceAll("\u0000", "")
}

/** Why a body was rejected, so the visitor can be told something they can act on. */
export type ChatRequestProblem = "malformed" | "message_too_long"

function parseChatRequest(raw: string): ChatRequest | ChatRequestProblem {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "malformed"
  }
  if (typeof parsed !== "object" || parsed === null) return "malformed"
  const body = parsed as Record<string, unknown>

  if (typeof body.tenantSlug !== "string" || body.tenantSlug.length === 0) return "malformed"
  if (typeof body.message !== "string" || body.message.length === 0) return "malformed"
  // Separated from every other malformed body, because this is the one a real visitor causes by
  // typing, and "invalid request" told them nothing while the widget turned it into
  // "temporarily unavailable" — which is both wrong and unactionable.
  if (body.message.length > MAX_MESSAGE_LENGTH) return "message_too_long"
  if (body.conversationId !== undefined && typeof body.conversationId !== "string") return "malformed"

  return {
    tenantSlug: body.tenantSlug,
    message: stripNulls(body.message),
    ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
  }
}

/** `true` only when `origin` is present in a non-empty allowlist. Both an absent
 *  header and an empty allowlist must fail closed — see `lookupTenantBySlug`. */
function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  return origin !== undefined && allowedOrigins.length > 0 && allowedOrigins.includes(origin)
}

/**
 * Resolves the conversation to append to, continuing the visitor's own or starting a new one.
 *
 * A supplied `conversationId` used to be taken on trust, which made it a capability: anyone who
 * learned an id could post into that conversation, and their words then sat in the history the
 * model reads for that visitor's next answer. Ids are unguessable, so this was never an open
 * door — but one that only stays shut because nobody finds the handle is not shut.
 *
 * So the id must belong to this tenant AND to this visitor. A mismatch quietly starts a fresh
 * conversation rather than refusing: the honest reason for one is a visitor whose address
 * changed — moving from wifi to a mobile network mid-conversation — and answering their question
 * in a new thread is a far better outcome than an error they cannot act on.
 */
async function ensureConversation(
  db: QuidDb,
  tenantId: string,
  visitorId: string,
  conversationId: string | undefined,
): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    if (conversationId) {
      // Scoped by row-level security to this tenant already; `visitor_id` is what makes it this
      // visitor's rather than merely this business's.
      const owned = rowsOf(
        await tx.execute(sql`
          SELECT id FROM conversations
          WHERE id = ${conversationId} AND visitor_id = ${visitorId}
        `),
      )[0]
      if (owned) return owned.id as string
    }
    const res = await tx.execute(sql`
      INSERT INTO conversations (tenant_id, channel, visitor_id)
      VALUES (${tenantId}, 'web', ${visitorId})
      RETURNING id
    `)
    return rowsOf(res)[0]!.id as string
  })
}

/** The stored transcript for a conversation, oldest first, so a follow-up question
 *  carries context from what came before it. */
async function loadHistory(
  db: QuidDb,
  tenantId: string,
  conversationId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  return withTenant(db, tenantId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT role, content
      FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at ASC
    `)
    return rowsOf(res).map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content as string,
    }))
  })
}

/**
 * Handles one visitor question over HTTP. Order of operations, and each step exists
 * for a reason:
 *
 * 1. Method and content type — anything but `POST application/json` is rejected before
 *    a single byte of the body is read.
 * 2. Parse and bound the body — a missing/non-string/oversized `message` is `400`.
 * 3. `lookupTenantBySlug` — an unknown slug is `404`.
 * 4. The origin check, AFTER the lookup, because the allowlist comes from it. This is
 *    the only thing standing between a business's assistant and anyone who copies its
 *    public slug — see `originAllowed`.
 * 5. Create the conversation if `conversationId` is absent, inside `withTenant`.
 * 6. The budget guard, BEFORE any provider call — see `budget.ts`. A tenant whose
 *    spend has reached a non-zero `monthly_budget_cents` is refused right here, with
 *    a recorded `budget_exhausted` escalation, and `answer()` (hence the provider) is
 *    never reached. Checking after the call would mean the request that exceeds the
 *    limit is the one that already paid for itself.
 * 7. `answer()` with the stored transcript as history.
 * 8. On a successful answer, record a `usage_events` row so the budget in step 6 can
 *    ever actually be reached — see `recordUsage`.
 * 9. Respond with the `PipelineResult` as JSON, plus the `conversationId` so the widget
 *    can send it back on the next turn.
 *
 * Everything from step 5 onward runs inside one try/catch. A STORE failure (a bug or
 * an outage, not a provider failure — `answer()` already turns provider failures into
 * a recorded refusal) is never allowed to reach the visitor as-is: it's logged to
 * OPERATIONAL logs, answered with a neutral 503, and — this is the part worth stating
 * plainly — NEVER recorded as an escalation. `escalations` is the signal a business
 * owner reads to decide what knowledge to add; an unreachable database is not that
 * signal, and recording it there would send them off rewriting content that was never
 * the problem. See the doc comment on `answer()` in `@quidchat/core` for the full
 * reasoning behind that split.
 */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ChatDeps,
  /** When true, reply as an event stream. The final payload is byte-identical either way —
   *  two shapes would drift and only one of them would stay tested. */
  stream = false,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" })
    return
  }

  const contentType = req.headers["content-type"] ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    sendJson(res, 400, { error: "expected application/json" })
    return
  }

  const raw = await readBoundedBody(req)
  if (raw === null) {
    sendJson(res, 400, { error: "request body too large" })
    return
  }

  const parsed = parseChatRequest(raw)
  if (parsed === "message_too_long") {
    sendJson(res, 400, {
      error: `message is longer than ${MAX_MESSAGE_LENGTH} characters`,
      reason: "message_too_long",
      maxLength: MAX_MESSAGE_LENGTH,
    })
    return
  }
  if (parsed === "malformed") {
    sendJson(res, 400, { error: "invalid request body" })
    return
  }
  const chatRequest = parsed

  const identity = await lookupTenantBySlug(deps.db, chatRequest.tenantSlug)
  if (!identity) {
    sendJson(res, 404, { error: "unknown tenant" })
    return
  }

  const origin = req.headers.origin
  if (!originAllowed(origin, identity.allowedOrigins)) {
    sendJson(res, 403, { error: "origin not allowed" })
    return
  }

  const visitorId = req.socket.remoteAddress ?? "unknown"

  // After the origin check, because an unauthorized caller has already been refused and
  // should not be able to consume a legitimate tenant's allowance by being rejected. Before
  // any write, because the point is to spend nothing on the request — no conversation row,
  // no history query, and above all no provider call.
  const decision = deps.rateLimiter.check({ tenantId: identity.tenantId, visitorId })
  if (!decision.allowed) {
    res.writeHead(429, {
      "content-type": "application/json; charset=utf-8",
      // Standard, and the widget reads it to back off instead of retrying immediately.
      "retry-after": String(decision.retryAfterSeconds),
    })
    res.end(JSON.stringify({ error: "too many requests", retryAfterSeconds: decision.retryAfterSeconds }))
    return
  }

  try {
    const conversationId = await ensureConversation(
      deps.db, identity.tenantId, visitorId, chatRequest.conversationId,
    )
    const history = await loadHistory(deps.db, identity.tenantId, conversationId)

    // The budget guard. `monthlyBudgetCents === 0` means unlimited — see budget.ts —
    // so `spentThisMonthCents` is only even queried when there's a real limit to
    // compare against, and the provider is never touched when the tenant is over it.
    const budget = await monthlyBudgetCents(deps.db, identity.tenantId)
    if (budget > 0 && (await spentThisMonthCents(deps.db, identity.tenantId)) >= budget) {
      const config = await deps.store.getTenantConfig(identity.tenantId)
      // Recorded the same way `answer()` records any other refusal, so a business
      // owner reviewing the transcript sees the question that went unanswered,
      // rather than a silent gap.
      await deps.store.recordUserTurn({ tenantId: identity.tenantId, conversationId, text: chatRequest.message })
      await deps.store.recordEscalation({
        tenantId: identity.tenantId, conversationId, reason: "budget_exhausted",
      })
      await deps.store.recordAnswer({
        tenantId: identity.tenantId,
        conversationId,
        segments: [{ kind: "general", text: config.refusalText }],
        citedChunkIds: [],
      })
      notifyEscalationInBackground({
        db: deps.db,
        notice: {
          tenantId: identity.tenantId, conversationId, question: chatRequest.message,
          reason: "budget_exhausted", channel: "web",
        },
        logError: deps.logError,
      })
      sendJson(res, 200, {
        conversationId, kind: "refused", text: config.refusalText, reason: "budget_exhausted",
      })
      return
    }

    if (stream) openEventStream(res)

    const result = await answer({
      store: deps.store,
      provider: deps.provider,
      tenantId: identity.tenantId,
      conversationId,
      history,
      question: chatRequest.message,
      ...(stream ? { onProgress: (stage) => sendProgress(res, stage) } : {}),
    })

    // Recorded for refusals as well as answers, and using the provider's own token
    // counts rather than an estimate. The `ungrounded` path generates twice and shows
    // the visitor nothing, so billing only successes would leave the most expensive
    // outcome in the system unbilled and therefore unbounded by any budget.
    //
    // Skipped only when nothing was generated at all — an empty knowledge base refuses
    // before the first completion, and a zero-cost row would just be noise in the
    // tenant's usage history.
    if (result.usage.inputTokens > 0 || result.usage.outputTokens > 0) {
      const config = await deps.store.getTenantConfig(identity.tenantId)
      await recordUsage(deps.db, {
        tenantId: identity.tenantId,
        model: config.chatModel,
        usage: result.usage,
      })
    }

    // A refusal IS the escalation signal — the assistant declining is exactly the moment a
    // person needs to take over — so the notice goes out here rather than from inside the
    // pipeline, which stays free of network and configuration concerns.
    if (result.kind === "refused") {
      notifyEscalationInBackground({
        db: deps.db,
        notice: {
          tenantId: identity.tenantId, conversationId, question: chatRequest.message,
          reason: result.reason, channel: "web",
        },
        logError: deps.logError,
      })
    }

    const payload = { conversationId, ...result }
    if (stream) sendResult(res, payload)
    else sendJson(res, 200, payload)
  } catch (e) {
    // A STORE failure, not a provider failure — `answer()` already caught and
    // recorded provider failures as a refusal. This is a bug or an outage, so it's
    // logged operationally rather than recorded as an `EscalationReason`, and the
    // visitor gets a generic 503 rather than a leaked stack trace.
    deps.logError("chat handler failed", e)
    // Headers are already sent on an open stream, so a 503 is impossible — the only way
    // to tell the client is an event. Closing silently would leave the widget waiting
    // forever, unable to distinguish a crash from a slow answer.
    if (res.headersSent) sendStreamError(res, "temporarily unavailable")
    else sendJson(res, 503, { error: "temporarily unavailable" })
  }
}
