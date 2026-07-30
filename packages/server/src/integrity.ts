import { sql } from "drizzle-orm"
import type { QuidDb } from "@quidchat/db"

/**
 * A cheap consistency check at start-up.
 *
 * The embedded tier keeps Postgres inside this process, so killing the process outright — an OOM,
 * a `kill -9` — can leave the heap and its indexes disagreeing. This project has seen the result:
 * two live versions of a row whose primary key permits one, after a server was killed rather than
 * stopped.
 *
 * The symptom is quiet, which is the problem. Reads return one version and writes land on the
 * other, so a business changes a setting in the panel, sees success, and nothing happens. Worse,
 * the two versions may not even be visible to the same transaction: the request path reads inside
 * `withTenant` and can see only one, while this check runs on the raw handle and sees both. That
 * is precisely why the check belongs here rather than in a request.
 *
 * It reports and does not repair. Deciding what a business's real configuration was is not a
 * decision a start-up routine should make silently, and an operator who knows their database is
 * inconsistent can restore a backup or re-enter the settings.
 */

export type IntegrityProblem = { table: string; detail: string }

/**
 * Rows whose primary key says one per tenant, but which the database is holding more than one of.
 *
 * Only `tenant_settings` for now, because it is the row every request reads and the one whose
 * silent divergence is invisible. Adding a table here costs one query at start-up.
 */
export async function checkIntegrity(db: QuidDb): Promise<IntegrityProblem[]> {
  const problems: IntegrityProblem[] = []
  const res = await db.execute(sql`
    SELECT tenant_id::text AS tenant_id, count(*)::int AS n
    FROM tenant_settings
    GROUP BY tenant_id
    HAVING count(*) > 1
  `)
  const rows = Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])

  for (const row of rows) {
    problems.push({
      table: "tenant_settings",
      detail: `tenant ${String(row.tenant_id)} has ${String(row.n)} settings rows; its primary key permits one`,
    })
  }
  return problems
}

/**
 * Runs the check and reports through `log`, returning what it found.
 *
 * Never throws and never refuses to start. A business whose database is inconsistent still wants
 * their assistant answering customers while they sort it out, and a server that refuses to boot
 * over a settings row would turn a quiet problem into an outage.
 */
export async function reportIntegrity(args: {
  db: QuidDb
  log: (line: string) => void
  logError: (message: string, cause: unknown) => void
}): Promise<IntegrityProblem[]> {
  try {
    const problems = await checkIntegrity(args.db)
    if (problems.length === 0) return []
    args.log("")
    args.log("This database is inconsistent, which usually means it was killed rather than stopped:")
    for (const problem of problems) args.log(`  ${problem.detail}`)
    args.log("Settings changes may appear to save and have no effect. Restore a backup, or")
    args.log("re-enter this tenant's settings and check they hold.")
    args.log("")
    return problems
  } catch (cause) {
    // The check itself is not worth failing a start-up over.
    args.logError("integrity check failed to run", cause)
    return []
  }
}
