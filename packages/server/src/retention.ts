import { withTenant, type QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"

/**
 * Deletes conversations older than each tenant's `retention_days`.
 *
 * The setting existed, the panel let a business change it, and nothing ever deleted anything.
 * A product that stores other people's customers' messages and displays "delete after 90
 * days" while keeping them forever is not merely missing a feature — it is making a promise
 * about someone else's personal data that it does not keep. That is why this exists.
 *
 * Only conversations are deleted, and the rest follows by cascade: messages, their citations
 * and escalations all carry `ON DELETE CASCADE` on the composite key back to the
 * conversation. Deleting each table separately would mean four chances to forget one and
 * leave orphaned customer text behind under a different name.
 *
 * `usage_events` is deliberately kept. It holds no customer text — a model name and token
 * counts — and it is what the monthly budget is computed from, so pruning it would silently
 * hand a tenant more spend than they configured. A retention policy is about personal data,
 * not about erasing the record of what was spent.
 */

export type PruneResult = {
  /** Per tenant, how many conversations were removed. Only tenants with a real limit appear. */
  byTenant: { tenantId: string; deleted: number }[]
  totalDeleted: number
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * Runs one pass over every tenant.
 *
 * The tenant list is read through the raw handle because it is genuinely cross-tenant work,
 * exactly like applying migrations; every deletion then runs inside `withTenant`, so
 * row-level security scopes it the same way a request would be scoped. Doing the deletes on
 * the raw handle would work and would be one bug away from deleting another tenant's rows.
 *
 * `retention_days = 0` means keep forever, matching `monthly_budget_cents = 0` meaning
 * unlimited. A tenant that has not thought about retention keeps their data rather than
 * discovering the default deleted it.
 */
export async function pruneExpiredConversations(db: QuidDb): Promise<PruneResult> {
  const tenants = rowsOf(
    await db.execute(sql`
      SELECT tenant_id, retention_days
      FROM tenant_settings
      WHERE retention_days > 0
    `),
  )

  const byTenant: { tenantId: string; deleted: number }[] = []
  for (const row of tenants) {
    const tenantId = row.tenant_id as string
    const days = Number(row.retention_days)
    // Guarded even though the query filters: a NULL or a nonsense value reaching the interval
    // arithmetic would either delete everything or nothing, and both are silent.
    if (!Number.isFinite(days) || days <= 0) continue

    const deleted = await withTenant(db, tenantId, async (tx) => {
      // `make_interval` rather than string concatenation into an interval literal. The value
      // comes from a table an admin API can write, and `${days} days` built as text is an
      // injection point in the one statement in this codebase that deletes customer data.
      const result = await tx.execute(sql`
        DELETE FROM conversations
        WHERE created_at < now() - make_interval(days => ${days})
        RETURNING id
      `)
      return rowsOf(result).length
    })

    if (deleted > 0) byTenant.push({ tenantId, deleted })
  }

  return { byTenant, totalDeleted: byTenant.reduce((sum, t) => sum + t.deleted, 0) }
}

/** A day. Retention is measured in days, so checking more often only adds load. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Starts the background pass and returns a function that stops it.
 *
 * Runs once at start-up as well as on the interval, because a deployment that restarts daily
 * would otherwise never reach the first tick and the policy would quietly never apply.
 *
 * The timer is `unref`'d so it never holds the process open: a server that will not exit
 * because a cleanup timer is pending looks like a hang, and an operator's next move is
 * `kill -9`, which is a worse habit than the timer is worth.
 *
 * A failure is logged and the schedule continues. Retention failing is not a reason to stop
 * answering customers, and a transient database error must not permanently disarm the policy
 * for the life of the process.
 */
export function startRetentionSchedule(args: {
  db: QuidDb
  logError: (message: string, cause: unknown) => void
  log?: (message: string) => void
  intervalMs?: number
}): () => void {
  const { db, logError } = args
  const log = args.log ?? (() => {})

  const run = () => {
    pruneExpiredConversations(db)
      .then((result) => {
        // Silent when there was nothing to do. A daily line saying zero trains an operator to
        // ignore the line that eventually says four thousand.
        if (result.totalDeleted > 0) {
          log(
            `retention: deleted ${result.totalDeleted} conversation(s) across ${result.byTenant.length} tenant(s)`,
          )
        }
      })
      .catch((cause: unknown) => logError("retention pass failed", cause))
  }

  run()
  const timer = setInterval(run, args.intervalMs ?? PRUNE_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
