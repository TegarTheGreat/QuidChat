import { withTenant, type QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"

/** Normalizes the `execute()` result, whose shape differs between drivers — see the
 *  identical helper in `chat.ts`, `tenant-lookup.ts`, and `@quidchat/db`'s `store.ts`. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * Reads the tenant's monthly budget in cents, straight off `tenant_settings`.
 *
 * `0` is the column's default, and it means UNLIMITED, not zero — see
 * `spentThisMonthCents` for why that reading, ugly as it is, is the correct one.
 */
export async function monthlyBudgetCents(db: QuidDb, tenantId: string): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const res = await tx.execute(sql`SELECT monthly_budget_cents FROM tenant_settings`)
    const rows = rowsOf(res)
    if (rows.length === 0) throw new Error(`tenant_settings not found: ${tenantId}`)
    return rows[0]!.monthly_budget_cents as number
  })
}

/**
 * Sums this calendar month's spend for a tenant. Returns cents.
 *
 * `monthly_budget_cents = 0` means unlimited, not zero — that is the column's default,
 * and treating the default as "spend nothing" would refuse every request on a fresh
 * install. Ugly, but the alternative is a migration to distinguish unset from zero, and
 * this reading is what the admin panel will present. The comparison itself lives in the
 * caller (`chat.ts`), which reads `monthlyBudgetCents` above and only calls this function
 * at all when that value is non-zero.
 */
export async function spentThisMonthCents(db: QuidDb, tenantId: string): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT COALESCE(SUM(cost_cents), 0)::bigint AS total
      FROM usage_events
      WHERE created_at >= date_trunc('month', now())
    `)
    return Number(rowsOf(res)[0]!.total)
  })
}

/**
 * Per-model price table, in cents per MILLION tokens. This is a starting point, not a
 * source of truth: prices change on the provider's schedule, not ours, and the admin
 * panel will eventually make this editable per tenant instead of hardcoded here. Kept
 * small and explicit on purpose — a table nobody can read at a glance is a table
 * nobody notices is stale.
 */
const MODEL_PRICES: Record<string, { inputPerMTokenCents: number; outputPerMTokenCents: number }> = {
  "claude-opus-5": { inputPerMTokenCents: 1_500, outputPerMTokenCents: 7_500 },
  "text-embedding-3-small": { inputPerMTokenCents: 2, outputPerMTokenCents: 0 },
}

/**
 * Rough token estimate from character count (~4 characters per token for English —
 * a common rule of thumb, not a real tokenizer). `answer()`'s `PipelineResult` does
 * not carry the provider's actual `CompleteResult.usage`, and widening that return
 * type is out of scope here, so this is what's available at the server boundary.
 * Good enough to make the budget arithmetic move; not a substitute for real
 * provider-reported usage, which a later task should thread through instead.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Cost in cents for a completion. An unknown model records `cost_cents: 0` rather
 * than a guess: a wrong number would silently distort every budget decision built on
 * top of it, while a visible zero is obviously incomplete and gets noticed and fixed.
 *
 * For a KNOWN model, the fractional cents are rounded UP, not to the nearest cent —
 * `cost_cents` is an integer column, and a metering system that quietly writes off
 * fractions of a cent on cheap requests is a system whose own budget can never
 * actually be reached, which would defeat the entire point of this table.
 */
export function costCentsFor(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[model]
  if (!price) return 0
  const rawCents =
    (inputTokens * price.inputPerMTokenCents + outputTokens * price.outputPerMTokenCents) / 1_000_000
  return Math.ceil(rawCents)
}

/**
 * Records one usage event after a successful answer, so `spentThisMonthCents` can
 * ever accumulate to a tenant's budget in the first place. `inputText`/`outputText`
 * are whatever text was sent to and received from the model, used only to produce
 * the token estimate described on `costCentsFor` — see `estimateTokens`.
 */
export async function recordUsage(
  db: QuidDb,
  args: { tenantId: string; model: string; inputText: string; outputText: string },
): Promise<void> {
  const inputTokens = estimateTokens(args.inputText)
  const outputTokens = estimateTokens(args.outputText)
  const costCents = costCentsFor(args.model, inputTokens, outputTokens)
  await withTenant(db, args.tenantId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, cost_cents)
      VALUES (${args.tenantId}, ${args.model}, ${inputTokens}, ${outputTokens}, ${costCents})
    `)
  })
}
