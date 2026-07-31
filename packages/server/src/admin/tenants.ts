import type { IncomingMessage, ServerResponse } from "node:http"
import { sql } from "drizzle-orm"
import { pgTextArray, readJsonBody, rowsOf, sendJson, type AdminDeps } from "./shared.js"

// Part of the admin API. The router and the shared helpers live in `../admin.ts`.

/** Cross-tenant: every tenant's slug, name, and id, for the admin panel's tenant
 *  picker. Uses the raw `db` handle, not `withTenant` — there is no single tenant
 *  context to scope this under. `tenants` carries RLS (policy `tenant_self`), so this
 *  is the second documented bypass the spec calls for, alongside `lookupTenantBySlug`. */
export async function listTenants(res: ServerResponse, deps: AdminDeps): Promise<void> {
  const result = await deps.db.execute(sql`SELECT id, slug, name FROM tenants ORDER BY slug`)
  const list = rowsOf(result).map((r) => ({ id: r.id, slug: r.slug, name: r.name }))
  sendJson(res, 200, { tenants: list })
}

/**
 * Creates a tenant (and its settings row) or updates an existing one's name and
 * allowed origins. Idempotent on `slug`, same as `packages/cli/src/init.ts`'s
 * `initTenant` — an operator or the admin panel re-submitting a form should not have
 * to know whether the tenant already exists.
 *
 * Uses the raw `db` handle rather than `withTenant`, and has to: the `tenant_self` RLS
 * policy scopes to `id = current_tenant_id()`, so inserting a brand-new tenant id can
 * never satisfy it — there is no tenant context to set before the row exists. This IS
 * "the admin routes' own tenant resolution" the spec carves out as a second documented
 * bypass, mirroring `initTenant`'s reasoning exactly.
 */
export async function createOrUpdateTenant(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return

  const { slug, name, origins } = body
  if (typeof slug !== "string" || slug.length === 0) {
    sendJson(res, 400, { error: "slug is required" })
    return
  }
  if (typeof name !== "string" || name.length === 0) {
    sendJson(res, 400, { error: "name is required" })
    return
  }
  if (!Array.isArray(origins) || !origins.every((o) => typeof o === "string")) {
    sendJson(res, 400, { error: "origins must be an array of strings" })
    return
  }

  const existing = rowsOf(
    await deps.db.execute(sql`SELECT id FROM tenants WHERE slug = ${slug}`),
  )[0]

  if (existing) {
    const tenantId = existing.id as string
    await deps.db.execute(sql`UPDATE tenants SET name = ${name} WHERE id = ${tenantId}`)
    await deps.db.execute(sql`
      UPDATE tenant_settings SET allowed_origins = ${pgTextArray(origins)}::text[] WHERE tenant_id = ${tenantId}
    `)
    sendJson(res, 200, { id: tenantId, slug, name, created: false })
    return
  }

  const inserted = rowsOf(
    await deps.db.execute(sql`INSERT INTO tenants (slug, name) VALUES (${slug}, ${name}) RETURNING id`),
  )[0]!
  const tenantId = inserted.id as string
  // Every other column has a default, so this row exists purely to make the tenant
  // configurable — see the identical note in `initTenant`.
  await deps.db.execute(sql`
    INSERT INTO tenant_settings (tenant_id, allowed_origins) VALUES (${tenantId}, ${pgTextArray(origins)}::text[])
  `)
  sendJson(res, 201, { id: tenantId, slug, name, created: true })
}

/**
 * `PATCH /tenants` — rename a business.
 *
 * The name is what appears in the panel's picker and nowhere a customer sees, so this is a label
 * an owner should be able to fix. The slug deliberately cannot change: it is in every embed script
 * tag already pasted onto a website, and renaming it would silently break every one of them with
 * no way for the shop to know why the widget stopped working.
 */
export async function renameTenant(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : ""
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!slug || !name) {
    sendJson(res, 400, { error: "slug and name are required" })
    return
  }

  // Cross-tenant by nature, like `listTenants` above: there is no single tenant context to scope
  // a rename of the tenant row itself under.
  const updated = rowsOf(
    await deps.db.execute(
      sql`UPDATE tenants SET name = ${name} WHERE slug = ${slug} RETURNING id, slug, name`,
    ),
  )[0]
  if (!updated) {
    sendJson(res, 404, { error: "no such tenant" })
    return
  }
  sendJson(res, 200, { tenant: updated })
}

/**
 * `DELETE /tenants` — remove a business and everything belonging to it.
 *
 * Every table carrying `tenant_id` references `tenants(id)` with `ON DELETE CASCADE`, so this
 * takes the documents, the chunks, the conversations, the transcripts, the channel credentials
 * and the provider key with it. There is no undo and no backup taken here.
 *
 * The caller must send the slug twice, in `slug` and in `confirm`. That is not ceremony: a tenant
 * is the largest thing this product can destroy, the panel offers it in the same menu as a rename,
 * and an id in a request body is easy to get wrong when two businesses have similar names.
 */
export async function deleteTenant(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : ""
  const confirm = typeof raw.confirm === "string" ? raw.confirm.trim() : ""
  if (!slug) {
    sendJson(res, 400, { error: "slug is required" })
    return
  }
  if (confirm !== slug) {
    sendJson(res, 400, { error: "confirm must repeat the tenant's slug exactly" })
    return
  }

  const removed = rowsOf(
    await deps.db.execute(sql`DELETE FROM tenants WHERE slug = ${slug} RETURNING id`),
  )[0]
  if (!removed) {
    sendJson(res, 404, { error: "no such tenant" })
    return
  }
  sendJson(res, 200, { ok: true })
}
