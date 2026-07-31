import type { IncomingMessage, ServerResponse } from "node:http"
import { withTenant } from "@quidchat/db"
import { sql, type SQL } from "drizzle-orm"
import { readJsonBody, resolveTenantOr404, rowsOf, sendJson, type AdminDeps } from "./shared.js"

// Part of the admin API. The router and the shared helpers live in `../admin.ts`.

/** One shape for a canned answer on every route. The list route mapping `created_at` to
 *  `createdAt` while `RETURNING` handed back the raw column was a difference the panel's
 *  types could not see and would have shown as an empty date after a create. */
export function cannedAnswerPayload(row: Record<string, unknown>) {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    createdAt: row.created_at,
  }
}

/**
 * `GET /admin/canned-answers` — every canned answer, drafts included.
 *
 * Drafts are returned alongside approved rows deliberately: a draft is invisible to
 * matching, so the only place an owner can ever see one is here. Filtering them out would
 * make an AI-proposed answer unreviewable, and review is the entire point of the draft
 * state.
 */
export async function listCannedAnswers(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        SELECT id, question, answer, status, created_at
        FROM canned_answers
        -- Drafts first: they are the ones waiting on a human, and an owner opening this
        -- screen is here to clear that queue.
        ORDER BY (status = 'draft') DESC, created_at DESC
      `),
    ),
  )

  sendJson(res, 200, { cannedAnswers: rows.map(cannedAnswerPayload) })
}

/**
 * `POST /admin/canned-answers` — add one.
 *
 * Created as a draft unless `approved: true` is sent explicitly. A person typing an answer
 * into the panel is that human review, so the panel does send it; the default stays `draft`
 * so that any other caller — a future AI suggestion, an import — cannot put text in front of
 * a customer without someone saying so.
 */
export async function createCannedAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    question: typeof raw.question === "string" ? raw.question : "",
    answer: typeof raw.answer === "string" ? raw.answer : "",
    approved: raw.approved === true,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (body.question.trim() === "" || body.answer.trim() === "") {
    sendJson(res, 400, { error: "question and answer are both required" })
    return
  }

  const created = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO canned_answers (tenant_id, question, answer, status)
      VALUES (
        ${tenantId}, ${body.question.trim()}, ${body.answer.trim()},
        ${body.approved ? "approved" : "draft"}
      )
      RETURNING id, question, answer, status, created_at
    `)
    return rowsOf(result)[0]!
  })
  sendJson(res, 201, { cannedAnswer: cannedAnswerPayload(created) })
}

/**
 * `POST /admin/canned-answers/status` — approve or send back to draft.
 *
 * A separate route from creation, and the only way a row becomes live. Approval is what
 * makes `static` mode trustworthy for price and warranty questions: every answer a customer
 * can receive was read by a person first. Un-approving is the same route, because taking a
 * wrong answer down has to be as easy as putting it up.
 */
export async function setCannedAnswerStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    id: typeof raw.id === "string" ? raw.id : "",
    approved: raw.approved,
  }

  // Shape first, database second: a malformed request should not cost a tenant lookup, and this
  // ordering is also what lets the rule below be tested without one.
  if (!body.id) {
    sendJson(res, 400, { error: "id is required" })
    return
  }
  // Required rather than defaulted. `raw.approved === true` read a missing field as false, so a
  // caller that sent only an id — or sent the field under another name — silently REVOKED a live
  // answer and got a 200 saying it worked. Publishing and un-publishing are opposite actions, and
  // the one that takes an answer away from customers must be asked for, not inferred.
  if (typeof body.approved !== "boolean") {
    sendJson(res, 400, { error: "approved must be true or false" })
    return
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return

  const updated = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        UPDATE canned_answers
        SET status = ${body.approved ? "approved" : "draft"}
        WHERE id = ${body.id}
        RETURNING id, status
      `),
    )[0],
  )
  // An id belonging to another tenant is invisible under RLS, so it lands here as "not
  // found" rather than as a successful no-op — which is the honest answer, and the same one
  // an id that genuinely does not exist gets.
  if (!updated) {
    sendJson(res, 404, { error: "canned answer not found" })
    return
  }
  sendJson(res, 200, { cannedAnswer: updated })
}

/** `DELETE /admin/canned-answers` — remove one. */
export async function deleteCannedAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    id: typeof raw.id === "string" ? raw.id : "",
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.id) {
    sendJson(res, 400, { error: "id is required" })
    return
  }

  const deleted = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(await tx.execute(sql`DELETE FROM canned_answers WHERE id = ${body.id} RETURNING id`))[0],
  )
  if (!deleted) {
    sendJson(res, 404, { error: "canned answer not found" })
    return
  }
  sendJson(res, 200, { ok: true })
}

/**
 * `PATCH /canned-answers` — correct the wording of an answer.
 *
 * An answer could be written and approved and then never touched. A price that changed, or a
 * sentence that read badly, could only be deleted and retyped — and because deleting is the only
 * way, the safe move was to leave the wrong one live. Editing an approved answer sends it back to
 * `draft`, deliberately: the approval was for the old words, and a person should read the new ones
 * before a customer does.
 */
export async function updateCannedAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return

  const id = typeof raw.id === "string" ? raw.id : ""
  const question = typeof raw.question === "string" ? raw.question.trim() : null
  const answer = typeof raw.answer === "string" ? raw.answer.trim() : null

  if (!id) {
    sendJson(res, 400, { error: "id is required" })
    return
  }
  if (question === null && answer === null) {
    sendJson(res, 400, { error: "nothing to change" })
    return
  }
  if (question === "" || answer === "") {
    sendJson(res, 400, { error: "question and answer cannot be empty" })
    return
  }

  const tenantId = await resolveTenantOr404(
    res,
    deps.db,
    typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
  )
  if (tenantId === null) return

  const sets: SQL[] = []
  if (question !== null) sets.push(sql`question = ${question}`)
  if (answer !== null) sets.push(sql`answer = ${answer}`)
  // Back to draft, always. The approval was for words that no longer exist.
  sets.push(sql`status = 'draft'`)

  const updated = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        UPDATE canned_answers SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
        RETURNING id, question, answer, status
      `),
    )[0],
  )
  if (!updated) {
    sendJson(res, 404, { error: "no such answer" })
    return
  }
  sendJson(res, 200, { cannedAnswer: updated })
}
