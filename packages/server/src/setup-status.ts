import { adviseSetup, isReadyToAnswer, type SetupSnapshot } from "@quidchat/core"
import { withTenant, type QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"
import { spentThisMonthCents } from "./budget.js"

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * Gathers everything the setup advisor needs, in one round trip per tenant.
 *
 * The advisor itself is pure and needs no model, so this endpoint works in static mode and
 * with no provider configured at all — which is the point. The owner asked for something
 * that helps set QuidChat up including when QuidChat is used without AI, and an advisor
 * that required a provider to explain how to run without one would be useless exactly
 * when it is most needed.
 *
 * `hasProvider` is passed in rather than detected here: the server was handed a provider at
 * construction, so whether one exists is already known and re-deriving it from the
 * environment could disagree with what is actually wired.
 */
export async function collectSetupSnapshot(args: {
  db: QuidDb
  tenantId: string
  hasProvider: boolean
}): Promise<SetupSnapshot> {
  const { db, tenantId, hasProvider } = args

  const counts = await withTenant(db, tenantId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM knowledge_sources)                              AS sources,
        (SELECT count(*)::int FROM knowledge_sources WHERE status = 'ready')       AS ready_sources,
        (SELECT count(*)::int FROM knowledge_sources WHERE status = 'error')       AS errored_sources,
        (SELECT count(*)::int FROM chunks)                                        AS chunks,
        (SELECT count(*)::int FROM canned_answers WHERE status = 'approved')       AS approved_canned,
        (SELECT count(*)::int FROM canned_answers WHERE status = 'draft')          AS draft_canned,
        (SELECT count(*)::int FROM escalations WHERE reason = 'no_source')         AS no_source_escalations
    `)
    return rowsOf(res)[0]!
  })

  const settings = await withTenant(db, tenantId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT answer_mode, monthly_budget_cents, high_risk_topics, refusal_text, allowed_origins
      FROM tenant_settings
    `)
    const rows = rowsOf(res)
    if (rows.length === 0) throw new Error(`tenant_settings not found for ${tenantId}`)
    // More than one row means RLS is not isolating — the same invariant getTenantConfig
    // asserts, for the same reason: silently taking the first row would report another
    // tenant's configuration as this tenant's.
    if (rows.length > 1) {
      throw new Error(`tenant isolation failure: tenant_settings returned ${rows.length} rows`)
    }
    return rows[0]!
  })

  const spent = await spentThisMonthCents(db, tenantId)

  return {
    allowedOrigins: (settings.allowed_origins ?? []) as string[],
    sourceCount: Number(counts.sources),
    readySourceCount: Number(counts.ready_sources),
    erroredSourceCount: Number(counts.errored_sources),
    chunkCount: Number(counts.chunks),
    approvedCannedAnswerCount: Number(counts.approved_canned),
    draftCannedAnswerCount: Number(counts.draft_canned),
    answerMode: settings.answer_mode as SetupSnapshot["answerMode"],
    monthlyBudgetCents: Number(settings.monthly_budget_cents),
    spentThisMonthCents: spent,
    escalationsNoSource: Number(counts.no_source_escalations),
    hasProvider,
    highRiskTopics: (settings.high_risk_topics ?? []) as string[],
    refusalText: (settings.refusal_text ?? "") as string,
  }
}

/** The shape returned by `GET /admin/setup`. */
export async function setupStatus(args: {
  db: QuidDb
  tenantId: string
  hasProvider: boolean
}): Promise<{
  ready: boolean
  findings: ReturnType<typeof adviseSetup>
  snapshot: SetupSnapshot
}> {
  const snapshot = await collectSetupSnapshot(args)
  const findings = adviseSetup(snapshot)
  // The snapshot is returned alongside the findings so the panel can show the numbers the
  // advice was derived from. Advice a reader cannot check is advice they will ignore.
  return { ready: isReadyToAnswer(findings), findings, snapshot }
}
