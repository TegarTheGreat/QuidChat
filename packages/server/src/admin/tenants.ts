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
