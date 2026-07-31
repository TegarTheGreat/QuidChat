import type { ServerResponse } from "node:http"
import { withTenant } from "@quidchat/db"
import { sql } from "drizzle-orm"
import { setupStatus } from "../setup-status.js"
import { lookupTenantBySlug } from "../tenant-lookup.js"
import { resolveTenantOr404, rowsOf, sendJson, type AdminDeps } from "./shared.js"

/**
 * What a business owner reads to judge how the assistant is doing: this month's spend, and
 * what is stopping it answering.
 */

export async function getUsage(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const { row, counts } = await withTenant(deps.db, tenantId, async (tx) => {
    // Mirrors `budget.ts`'s `spentThisMonthCents`, but broken out by token direction
    // rather than collapsed to a single cost figure — this is what the admin panel
    // shows a business owner, not what `chat.ts` compares against a budget.
    const result = await tx.execute(sql`
      SELECT COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
             COALESCE(SUM(cost_cents), 0)::bigint AS cost_cents
      FROM usage_events
      WHERE created_at >= date_trunc('month', now())
    `)
    /*
     * The figures a shop owner can act on.
     *
     * Cost alone told them what the month had spent and nothing about whether it was worth
     * spending. How many customers asked, how many got an answer, and how many are still waiting
     * for one is the difference between an overview and a meter — and the ratio between the first
     * two is the number that says whether the knowledge base is doing its job.
     */
    const activity = await tx.execute(sql`
      SELECT
        (SELECT count(*) FROM messages
          WHERE role = 'user' AND created_at >= date_trunc('month', now()))::int AS questions,
        (SELECT count(*) FROM escalations
          WHERE occurred_at >= date_trunc('month', now()))::int AS refusals,
        (SELECT count(*) FROM escalations WHERE resolved_at IS NULL)::int AS open_escalations
    `)
    return { row: rowsOf(result)[0]!, counts: rowsOf(activity)[0]! }
  })
  sendJson(res, 200, {
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costCents: Number(row.cost_cents),
    questions: Number(counts.questions),
    refusals: Number(counts.refusals),
    /** Not this month's — every one still waiting for an answer, whenever it was asked. */
    openEscalations: Number(counts.open_escalations),
  })
}

/**
 * Dispatches every `/admin/...` route (already stripped of any `/v1` prefix by the
 * caller — see `server.ts`). Every route requires `Authorization: Bearer <token>`
 * against `QUIDCHAT_ADMIN_TOKEN`, checked here, once, BEFORE any body is read or any
 * query runs — see `checkAdminAuth`.
 *
 * Scoping is by an explicit `tenantSlug` in the query (`GET`) or body (`POST`/`PATCH`),
 * resolved with the same `lookupTenantBySlug` the public `/chat` route uses — not the
 * origin-allowlist path, which exists for visitors, not operators.
 */
/**
 * `GET /admin/setup?tenantSlug=…`
 *
 * What is stopping this tenant from answering, and what to do about it.
 *
 * A first-time owner has a technically valid installation that answers nothing, because
 * there is no content and no allowed origin, and nothing else in the product tells them
 * that. The advice is pure inspection — no model is involved — so this works in static
 * mode and with no provider configured, which is exactly when an owner most needs to be
 * told what is wrong.
 */
export async function getSetup(
  res: ServerResponse,
  deps: AdminDeps,
  searchParams: URLSearchParams,
): Promise<void> {
  const tenantSlug = searchParams.get("tenantSlug")
  if (!tenantSlug) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return
  }
  const identity = await lookupTenantBySlug(deps.db, tenantSlug)
  if (!identity) {
    sendJson(res, 404, { error: "unknown tenant" })
    return
  }
  const status = await setupStatus({
    db: deps.db,
    tenantId: identity.tenantId,
    // The server was handed a provider at construction, so this is already known —
    // re-deriving it from the environment could disagree with what is actually wired.
    hasProvider: true,
  })
  sendJson(res, 200, status)
}
