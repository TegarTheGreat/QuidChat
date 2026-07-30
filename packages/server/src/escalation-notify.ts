import { withTenant, type QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"

/**
 * Tells the business when their assistant could not answer.
 *
 * `escalation_mode` and `escalation_target` were settings the panel let a business change and
 * nothing read. Escalations were recorded and sat in a table, so a customer who asked
 * something the assistant had no source for was told "may I connect you with our team?" and
 * nobody on that team learned there was anyone to connect to. The refusal is honest; leaving
 * it unreported is what makes it useless.
 *
 * `collect_contact` — the default — stays record-only, which is the honest behaviour for a
 * business that has not configured anywhere to send it: the escalation is in the panel, and
 * that is what the panel is for. `webhook` posts it. A webhook covers Slack, Discord, n8n,
 * Zapier, a CRM and a two-line script equally, which is why it is the one delivery mechanism
 * here rather than SMTP — email would mean credentials, a queue, bounce handling and a
 * dependency, to reach a place most teams forward to chat anyway.
 */

export type EscalationNotice = {
  tenantId: string
  conversationId: string
  /** What the customer asked. Without it the notice says something went wrong but not what. */
  question: string
  reason: string
  channel: string
}

/** Bounded: the notice is fire-and-forget, and a webhook that never answers must not keep a
 *  socket and a promise alive indefinitely behind every refusal. */
const TIMEOUT_MS = 5_000

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * Delivers one notice, or does nothing when the tenant has not asked for delivery.
 *
 * NEVER THROWS. The caller is on the path of a customer's question that has already been
 * answered — with a refusal, but answered — and a webhook being down is not a reason to turn
 * that into an error the customer sees. Failures are logged operationally, which is the same
 * split `answer()` makes between what a business owner reads and what an operator watches.
 *
 * Unlike reading a knowledge-source URL, the target is not checked against private address
 * ranges. A visitor chooses a source URL; only an authenticated admin sets this, and an
 * internal CRM or a chat relay on the deployment's own network is a legitimate and common
 * target. Refusing private addresses here would block the ordinary case to defend against
 * someone who already holds the admin token — and therefore already has the server.
 */
export async function notifyEscalation(args: {
  db: QuidDb
  notice: EscalationNotice
  logError: (message: string, cause: unknown) => void
  fetchImpl?: typeof fetch
}): Promise<void> {
  const { db, notice, logError } = args
  const doFetch = args.fetchImpl ?? fetch

  try {
    const settings = await withTenant(db, notice.tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT escalation_mode, escalation_target FROM tenant_settings`),
      )[0],
    )
    if (!settings) return

    const mode = settings.escalation_mode as string
    const target = (settings.escalation_target as string | null) ?? ""
    if (mode !== "webhook" || target.trim() === "") return

    const response = await doFetch(target.trim(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        // A flat, stable shape. Whatever is on the other end is somebody's script or a chat
        // integration's template, and renaming a field later breaks it silently.
        event: "escalation",
        reason: notice.reason,
        question: notice.question,
        channel: notice.channel,
        conversationId: notice.conversationId,
      }),
    })

    if (!response.ok) {
      // Worth logging with the status: a 404 means the URL is wrong and a 401 means the
      // token is, and those are different fixes for what otherwise looks like one silence.
      logError(`escalation webhook returned HTTP ${response.status}`, new Error(target))
    }
  } catch (cause) {
    logError("escalation webhook failed", cause)
  }
}

/**
 * Sends the notice without making the caller wait.
 *
 * The customer's response must not be held while a third-party webhook is contacted; a
 * business whose relay is slow would otherwise make every unanswerable question slow for
 * their customers too. `void` plus a `catch` is deliberate rather than lazy: an unhandled
 * rejection here would be an unhandled rejection in the server process.
 */
export function notifyEscalationInBackground(args: {
  db: QuidDb
  notice: EscalationNotice
  logError: (message: string, cause: unknown) => void
}): void {
  void notifyEscalation(args).catch((cause: unknown) =>
    args.logError("escalation notification failed unexpectedly", cause),
  )
}
