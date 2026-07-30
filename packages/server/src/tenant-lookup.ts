import type { QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export type TenantIdentity = { tenantId: string; allowedOrigins: string[] }

/**
 * Resolves a tenant from its public site slug, and returns the origins that slug is
 * allowed to be embedded on.
 *
 * THIS IS THE ONLY QUERY IN THE SERVER THAT BYPASSES ROW-LEVEL SECURITY, and it has to:
 * `withTenant` needs a tenant id, and this is the lookup that produces one. There is no
 * ordering of operations that avoids it.
 *
 * It is kept deliberately narrow rather than exposing a general raw-handle helper. It
 * takes a slug, returns an id and an origin list, and touches nothing else. Every other
 * query in this package goes through `withTenant`. If a second bypass is ever needed,
 * it belongs beside this one with its own justification, not hidden inside a route.
 *
 * The slug is public by design — it ships inside a website's HTML, exactly like the app
 * id of any hosted chat widget. It is not a secret and must never be treated as one; the
 * origin allowlist is what limits where it can be used.
 */
export async function lookupTenantBySlug(
  db: QuidDb,
  slug: string,
): Promise<TenantIdentity | null> {
  const res = await db.execute(sql`
    SELECT t.id, s.allowed_origins
    FROM tenants t
    JOIN tenant_settings s ON s.tenant_id = t.id
    WHERE t.slug = ${slug}
  `)
  const row = rowsOf(res)[0]
  if (!row) return null
  return {
    tenantId: row.id as string,
    allowedOrigins: (row.allowed_origins ?? []) as string[],
  }
}
