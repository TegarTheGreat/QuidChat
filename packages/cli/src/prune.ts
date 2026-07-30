import { applyMigrations, createDb } from "@quidchat/db"
import { pruneExpiredConversations } from "@quidchat/server"
import { readServeConfig } from "./config.js"

/**
 * Applies every tenant's retention window once, then exits.
 *
 * The server runs the same pass daily, so this exists for the deployment shape where that is
 * not good enough: a container that is started per request, or an operator who would rather
 * see retention in their own crontab than trust a timer inside a process they restart often.
 *
 * It reports what it deleted even when that is nothing. A cron job whose output is silence on
 * success is one nobody can tell apart from a cron job that never ran.
 */
export async function runPrune(args: {
  env: Record<string, string | undefined>
  log?: (line: string) => void
}): Promise<{ totalDeleted: number }> {
  const log = args.log ?? ((line: string) => console.log(line))
  const config = readServeConfig(args.env)
  const db = await createDb(config.db)
  await applyMigrations(db)

  const result = await pruneExpiredConversations(db)
  log(
    result.totalDeleted === 0
      ? "retention: nothing past its window"
      : `retention: deleted ${result.totalDeleted} conversation(s) across ${result.byTenant.length} tenant(s)`,
  )
  return { totalDeleted: result.totalDeleted }
}
