import type { ServerResponse } from "node:http"
import { withTenant, type QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"
import { lookupTenantBySlug } from "./tenant-lookup.js"

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * The only `widget_theme` keys this route will ever hand back, matching the key
 * names the widget itself reads (see `packages/widget/src/theme.ts`). `widget_theme`
 * is otherwise a free-form jsonb blob an operator edits as raw JSON text in the admin
 * panel (`admin/src/components/settings-dialog.tsx`) — nothing constrains its shape
 * at write time, so this allowlist, not the column's own contents, is what keeps a
 * public route from ever forwarding whatever else ends up in that blob.
 */
const THEME_KEYS = ["primaryColor", "position", "title", "locale", "greeting"] as const

/** How many opening questions a visitor is offered. Past four, a panel that was meant to
 *  remove hesitation becomes a menu to read. */
const MAX_STARTERS = 4

/**
 * Serves the tenant's widget theme as JSON, e.g. `GET /widget-config?tenantSlug=acme`
 * (also reachable as `/v1/widget-config?tenantSlug=acme`, per `stripVersionPrefix` in
 * server.ts).
 *
 * PUBLIC AND UNAUTHENTICATED, exactly like `handleWidgetAsset` — the widget calls
 * this from a visitor's browser before any conversation exists, so there is no
 * session or origin check available to gate it behind. That constraint is also why
 * this handler exists at all: because it can never require auth, it must never
 * return anything but presentation fields. `refusal_text`, the model names, the
 * monthly budget, and `allowed_origins` all live in the same `tenant_settings` row
 * and must never reach here. The row is never spread; only the names in
 * `THEME_KEYS` are ever read off it, and only when their value is actually a
 * string — `widget_theme` is unvalidated JSON, so an operator could put an object
 * or array under any of these keys, and the widget only ever expects a string.
 *
 * An unknown tenant slug answers 404. This mirrors `handleWidgetAsset`'s spirit
 * of naming the real problem: a 200 with an empty theme would look identical to
 * a tenant that simply has no theme configured, silently hiding a typo in the
 * embed's `data-quidchat-tenant` attribute.
 */
export async function handleWidgetConfig(
  res: ServerResponse,
  db: QuidDb,
  tenantSlug: string,
): Promise<void> {
  const identity = await lookupTenantBySlug(db, tenantSlug)
  if (identity === null) {
    sendJson(res, 404, { error: "unknown tenant" })
    return
  }

  const { theme, cannedQuestions, tenantName } = await withTenant(db, identity.tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT widget_theme FROM tenant_settings`)
    const rows = rowsOf(result)
    if (rows.length === 0) throw new Error(`tenant_settings not found for ${identity.tenantId}`)
    // Same invariant `setupStatus` asserts, for the same reason: more than one row
    // means RLS has stopped isolating tenants, and silently taking the first would
    // leak one tenant's theme to another tenant's visitors.
    if (rows.length > 1) {
      throw new Error(`tenant isolation failure: tenant_settings returned ${rows.length} rows`)
    }
    // Only APPROVED ones. A draft is text a person has not yet agreed to show a customer, and
    // putting it on the opening screen would show it to every one of them.
    const canned = await tx.execute(
      sql`SELECT question FROM canned_answers WHERE status = 'approved'
          ORDER BY created_at ASC LIMIT ${MAX_STARTERS}`,
    )
    // The tenant's own name, for the panel header. `tenants` carries the `tenant_self` policy,
    // so this returns exactly one row inside `withTenant` — the business asking about itself.
    const named = rowsOf(await tx.execute(sql`SELECT name FROM tenants`))[0]
    return {
      tenantName: typeof named?.name === "string" ? named.name : "",
      theme: (rows[0]!.widget_theme ?? {}) as Record<string, unknown>,
      cannedQuestions: rowsOf(canned)
        .map((r) => r.question)
        .filter((q): q is string => typeof q === "string" && q.trim() !== ""),
    }
  })

  const body: Record<string, unknown> = {}
  for (const key of THEME_KEYS) {
    const value = theme[key]
    if (typeof value === "string") body[key] = value
  }

  /*
   * The header names the business unless it was given something else to say.
   *
   * It read "Chat assistant" on every site that had not opened the theme editor, which tells a
   * customer nothing and reads like software someone bolted on. The shop's own name is already
   * on the page around the widget; matching it is what makes the thing look like part of the
   * shop rather than a third party sitting in the corner of it.
   */
  if (typeof body.title !== "string" && tenantName.trim() !== "") {
    body.title = tenantName
  }

  /*
   * Opening questions.
   *
   * An empty chat box is the reason widgets go unused: a visitor who has nothing to react to has
   * to invent a question and guess whether this thing can answer it, and most people close it
   * instead. Showing what it can answer removes both problems at once.
   *
   * The default comes from the business's APPROVED canned answers, because those already are the
   * questions this business knows it gets — a shop that has done that setup gets openers with no
   * further configuration, and they are guaranteed answerable. An owner who wants different ones
   * sets `starters` explicitly and that wins.
   */
  const explicit = theme.starters
  const starters = Array.isArray(explicit)
    ? explicit.filter((s): s is string => typeof s === "string" && s.trim() !== "").slice(0, MAX_STARTERS)
    : cannedQuestions
  if (starters.length > 0) body.starters = starters

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    // Short-lived, not immutable like /quidchat.js: a business changing its theme
    // should see the change on the next page load within about a minute, not only
    // after a customer's browser cache expires or is cleared by hand. A minute
    // also still saves a database round trip for every widget mount on a busy site.
    "cache-control": "public, max-age=60",
  })
  res.end(JSON.stringify(body))
}
