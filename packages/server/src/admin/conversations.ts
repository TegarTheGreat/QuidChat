import type { IncomingMessage, ServerResponse } from "node:http"
import { withTenant } from "@quidchat/db"
import { sql } from "drizzle-orm"
import { readJsonBody, resolveTenantOr404, rowsOf, sendJson, type AdminDeps } from "./shared.js"

// Part of the admin API. The router and the shared helpers live in `../admin.ts`.

/**
 * `POST /admin/escalations/resolve` — mark one as handled.
 *
 * Without this the list only grows. An owner who has just written the answer to a question has
 * no way to say so, so the screen that exists to show them what still needs attention shows
 * them everything they have ever been asked. `resolved_at` has been in the schema since the
 * first migration and nothing ever set it.
 *
 * Unresolving is the same route with `resolved: false`, because deciding an answer was wrong
 * has to be as easy as deciding it was right.
 */
export async function resolveEscalation(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    id: typeof raw.id === "string" ? raw.id : "",
    resolved: raw.resolved !== false,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.id) {
    sendJson(res, 400, { error: "id is required" })
    return
  }

  const updated = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        UPDATE escalations
        SET resolved_at = ${body.resolved ? sql`now()` : sql`NULL`}
        WHERE id = ${body.id}
        RETURNING id, resolved_at
      `),
    )[0],
  )
  if (!updated) {
    sendJson(res, 404, { error: "escalation not found" })
    return
  }
  sendJson(res, 200, { id: updated.id, resolvedAt: updated.resolved_at })
}

export async function listConversations(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT c.id, c.channel, c.visitor_id, c.status, c.created_at,
             count(m.id)::int AS message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 50
    `)
    return rowsOf(result)
  })
  sendJson(res, 200, {
    conversations: rows.map((r) => ({
      id: r.id, channel: r.channel, visitorId: r.visitor_id, status: r.status,
      createdAt: r.created_at, messageCount: r.message_count,
    })),
  })
}

/**
 * `GET /admin/conversation` — one transcript, with citations.
 *
 * A separate request from the list rather than messages embedded in it. Fifty conversations
 * with every message and every citation is a payload that grows with a tenant's traffic and is
 * almost entirely thrown away — the reader opens one. This is the request that happens when
 * they do.
 *
 * Citations carry the document TITLE, never the chunk id. The title is the whole point of the
 * product's promise made visible: "we accept returns within seven days, from Store Policy" is
 * checkable by a human, and a uuid is not.
 *
 * The skill that answered is included because a wrong answer and a wrongly-routed answer look
 * identical in a transcript otherwise, and they need different fixes: one is missing content,
 * the other is a routing rule.
 */
export async function getConversation(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return
  const conversationId = params.get("id")
  if (!conversationId) {
    sendJson(res, 400, { error: "id is required" })
    return
  }

  const payload = await withTenant(deps.db, tenantId, async (tx) => {
    const conversation = rowsOf(
      await tx.execute(sql`
        SELECT id, channel, visitor_id, status, created_at
        FROM conversations WHERE id = ${conversationId}
      `),
    )[0]
    if (!conversation) return null

    const messages = rowsOf(
      await tx.execute(sql`
        SELECT m.id, m.role, m.content, m.created_at, s.name AS skill_name
        FROM messages m
        LEFT JOIN skills s ON s.id = m.skill_id
        WHERE m.conversation_id = ${conversationId}
        ORDER BY m.created_at ASC, m.id ASC
      `),
    )

    const citations = rowsOf(
      await tx.execute(sql`
        SELECT mc.message_id, d.id AS document_id, d.title
        FROM message_citations mc
        JOIN chunks ch ON ch.id = mc.chunk_id
        JOIN documents d ON d.id = ch.document_id
        JOIN messages m ON m.id = mc.message_id
        WHERE m.conversation_id = ${conversationId}
      `),
    )
    return { conversation, messages, citations }
  })

  if (!payload) {
    sendJson(res, 404, { error: "conversation not found" })
    return
  }

  sendJson(res, 200, {
    conversation: {
      id: payload.conversation.id,
      channel: payload.conversation.channel,
      visitorId: payload.conversation.visitor_id,
      status: payload.conversation.status,
      startedAt: payload.conversation.created_at,
      messages: payload.messages.map((m) => {
        // One document cited twice in the same answer is two chunks from one file, and showing
        // its name twice reads as a mistake rather than as thoroughness.
        const seen = new Set<string>()
        const messageCitations = payload.citations
          .filter((c) => c.message_id === m.id)
          .filter((c) => {
            const id = c.document_id as string
            if (seen.has(id)) return false
            seen.add(id)
            return true
          })
          .map((c) => ({ sourceId: c.document_id, title: c.title }))
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          skillName: m.skill_name,
          citations: messageCitations,
        }
      }),
    },
  })
}

export async function listEscalations(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) => {
    // `escalations.occurred_at` exists now, so this orders by the moment the escalation
    // actually happened rather than by its parent conversation — which was exact for a
    // conversation with one escalation and wrong for one with several. This list is what
    // an owner reads to decide what content to write next, and the wrong order sends them
    // to the oldest gap first.
    //
    // The question text is joined in as well: a reason alone says the bot could not
    // answer, while the question says what to write.
    const result = await tx.execute(sql`
      SELECT e.id, e.reason, e.resolved_at, e.occurred_at, e.conversation_id,
             (
               SELECT m.content FROM messages m
               WHERE m.conversation_id = e.conversation_id AND m.role = 'user'
               ORDER BY m.created_at DESC
               LIMIT 1
             ) AS question
      FROM escalations e
      -- Unhandled first, newest first within that. This screen is a queue, and a resolved item
      -- pushing an unhandled one further down the page defeats the reason to open it.
      ORDER BY (e.resolved_at IS NULL) DESC, e.occurred_at DESC, e.id DESC
    `)
    return rowsOf(result)
  })
  sendJson(res, 200, {
    escalations: rows.map((r) => ({
      id: r.id, reason: r.reason, conversationId: r.conversation_id,
      resolvedAt: r.resolved_at, occurredAt: r.occurred_at, question: r.question,
    })),
  })
}
