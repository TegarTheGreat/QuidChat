import type { IncomingMessage, ServerResponse } from "node:http"
import { withTenant } from "@quidchat/db"
import { sql, type SQL } from "drizzle-orm"
import { pgTextArray, readJsonBody, resolveTenantOr404, rowsOf, sendJson, type AdminDeps } from "./shared.js"

/**
 * The one settings row for a tenant, or a loud failure.
 *
 * `getTenantConfig` and the setup endpoint have always asserted this; these two routes quietly
 * took the first row instead, and the difference is not theoretical. A database left inconsistent
 * by an unclean shutdown — an OOM kill, a `kill -9` — can hold two live versions of a row whose
 * primary key says only one may exist. Reads then return one and writes land on the other, so a
 * business changes a setting in the panel, sees success, and nothing happens.
 *
 * Reporting it is the whole point. A silent wrong answer here is a business believing they have
 * configured something they have not.
 */
export function onlySettingsRow(rows: Record<string, unknown>[], tenantId: string): Record<string, unknown> | null {
  if (rows.length === 0) return null
  if (rows.length > 1) {
    throw new Error(
      `tenant_settings holds ${rows.length} rows for ${tenantId}, which its primary key forbids — ` +
        "the database is inconsistent, most likely after an unclean shutdown",
    )
  }
  return rows[0]!
}

// Part of the admin API. The router and the shared helpers live in `../admin.ts`.

export async function getSettings(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const row = await withTenant(deps.db, tenantId, async (tx) => {
    // No `WHERE tenant_id` — RLS does the scoping, same as every other read in
    // `@quidchat/db`'s `store.ts`.
    const result = await tx.execute(sql`SELECT * FROM tenant_settings`)
    return onlySettingsRow(rowsOf(result), tenantId)
  })
  if (!row) {
    sendJson(res, 404, { error: "tenant settings not found" })
    return
  }
  sendJson(res, 200, row)
}

/**
 * An explicit ALLOWLIST of writable `tenant_settings` columns, not a denylist — a
 * future column added to the table is simply not writable through this route until it
 * is deliberately added here, rather than being writable by accident the moment it
 * exists.
 */
export const SETTINGS_COLUMNS = new Set([
  "answer_mode", "chat_model", "rewrite_model", "embedding_model", "refusal_text", "escalation_mode",
  "escalation_target", "monthly_budget_cents", "retention_days", "high_risk_topics",
  "allowed_origins", "widget_theme", "max_handoffs_per_turn", "max_handoffs_per_conversation",
])

/** The two `text[]` columns in the allowlist above — see `pgTextArray`. */
export const ARRAY_SETTINGS_COLUMNS = new Set(["high_risk_topics", "allowed_origins"])

export async function patchSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return

  const { tenantSlug, ...fields } = body
  if (typeof tenantSlug !== "string" || tenantSlug.length === 0) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return
  }

  const keys = Object.keys(fields)
  if (keys.length === 0) {
    sendJson(res, 400, { error: "no settings fields provided" })
    return
  }
  const unknownKeys = keys.filter((k) => !SETTINGS_COLUMNS.has(k))
  if (unknownKeys.length > 0) {
    sendJson(res, 400, { error: `unknown settings field(s): ${unknownKeys.join(", ")}` })
    return
  }

  const tenantId = await resolveTenantOr404(res, deps.db, tenantSlug)
  if (tenantId === null) return

  const setClauses: SQL[] = []
  for (const key of keys) {
    const value = fields[key]
    if (ARRAY_SETTINGS_COLUMNS.has(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        sendJson(res, 400, { error: `${key} must be an array of strings` })
        return
      }
      // `key` is only ever one of the hardcoded literals in `SETTINGS_COLUMNS` at this
      // point — checked above — so `sql.raw` on it is not user-controlled SQL text.
      setClauses.push(sql`${sql.raw(key)} = ${pgTextArray(value)}::text[]`)
    } else if (key === "answer_mode") {
      // Constrained in SQL, so an invalid value would come back as a database error written
      // for an operator. This is also the single most consequential setting a business owner
      // can change — `static` stops calling the model entirely — so a typo silently becoming
      // a 500 is the wrong outcome.
      if (typeof value !== "string" || !["static", "thrifty", "full"].includes(value)) {
        sendJson(res, 400, { error: "answer_mode must be static, thrifty or full" })
        return
      }
      setClauses.push(sql`${sql.raw(key)} = ${value}`)
    } else if (key === "escalation_mode") {
      // No CHECK constraint backs this column, so an unrecognised value would be accepted and
      // then silently behave as record-only — the business would believe they had configured
      // delivery and hear nothing. Validated here, where the message can say what is allowed.
      if (typeof value !== "string" || !["collect_contact", "webhook"].includes(value)) {
        sendJson(res, 400, { error: "escalation_mode must be collect_contact or webhook" })
        return
      }
      setClauses.push(sql`${sql.raw(key)} = ${value}`)
    } else if (key === "escalation_target") {
      // `null` is the column's own resting state — a tenant that has never set a webhook — and it
      // is also the only way to clear one. Rejecting it meant a tenant with no target could not
      // save ANY setting: the panel reads the row, sends it back, and this refused the value it
      // had just handed out. Found by driving the settings dialog in a browser.
      if (value === null) {
        setClauses.push(sql`${sql.raw(key)} = NULL`)
        continue
      }
      // Only checked for shape, not reachability. A target that is not a URL at all would
      // fail on every escalation with nothing but a log line to show for it.
      if (typeof value !== "string") {
        sendJson(res, 400, { error: "escalation_target must be a string or null" })
        return
      }
      if (value.trim() !== "" && !/^https?:\/\//.test(value.trim())) {
        sendJson(res, 400, { error: "escalation_target must be an http or https URL" })
        return
      }
      setClauses.push(sql`${sql.raw(key)} = ${value.trim()}`)
    } else if (key === "widget_theme") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        sendJson(res, 400, { error: "widget_theme must be an object" })
        return
      }
      setClauses.push(sql`${sql.raw(key)} = ${JSON.stringify(value)}::jsonb`)
    } else {
      setClauses.push(sql`${sql.raw(key)} = ${value}`)
    }
  }

  const row = await withTenant(deps.db, tenantId, async (tx) => {
    await tx.execute(sql`UPDATE tenant_settings SET ${sql.join(setClauses, sql`, `)}`)
    const result = await tx.execute(sql`SELECT * FROM tenant_settings`)
    return onlySettingsRow(rowsOf(result), tenantId)
  })
  sendJson(res, 200, row)
}
