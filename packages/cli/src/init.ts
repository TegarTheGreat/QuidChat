import { applyMigrations, createDb, type QuidDb } from "@quidchat/db"
import { sql } from "drizzle-orm"
import { readServeConfig } from "./config.js"

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export type InitResult = { tenantId: string; slug: string; created: boolean }

/**
 * Renders a JS string array as a Postgres array literal.
 *
 * Passing the array as a bind parameter does not work here: it is flattened into a single
 * scalar, so `text[]` receives one string and the insert fails. The same pattern is used
 * for `vector` in `packages/db/src/store.ts`. Quotes are escaped because an origin is
 * operator-supplied and a stray quote would otherwise break the literal.
 */
function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`
}

/**
 * Creates a tenant, its settings row, and its allowed origins.
 *
 * This uses the raw database handle rather than `withTenant`, and it has to: the
 * `tenant_self` policy scopes rows to `id = current_tenant_id()`, so an INSERT as the
 * unprivileged application role can never succeed — a freshly generated id cannot equal
 * a tenant context that does not exist yet. Onboarding is therefore a privileged
 * operation by design, and a command-line tool run by the operator is the right place
 * for it. The spec records this as the same hazard class as admin session lookup.
 *
 * Idempotent on the slug: running it twice updates the origins rather than failing. An
 * operator adding a second domain should not have to know whether the tenant exists.
 */
export async function initTenant(args: {
  db: QuidDb
  slug: string
  name: string
  origins: string[]
}): Promise<InitResult> {
  const { db, slug, name, origins } = args

  const existing = rowsOf(
    await db.execute(sql`SELECT id FROM tenants WHERE slug = ${slug}`),
  )[0]

  if (existing) {
    const tenantId = existing.id as string
    await db.execute(sql`
      UPDATE tenant_settings SET allowed_origins = ${pgTextArray(origins)}::text[] WHERE tenant_id = ${tenantId}
    `)
    return { tenantId, slug, created: false }
  }

  const inserted = rowsOf(
    await db.execute(sql`
      INSERT INTO tenants (slug, name) VALUES (${slug}, ${name}) RETURNING id
    `),
  )[0]
  const tenantId = inserted!.id as string

  // Every other column has a default, so the settings row exists purely to make the
  // tenant configurable. Creating it here means the admin panel never has to handle a
  // tenant with no settings, which would otherwise be a state it could observe.
  await db.execute(sql`
    INSERT INTO tenant_settings (tenant_id, allowed_origins)
    VALUES (${tenantId}, ${pgTextArray(origins)}::text[])
  `)

  return { tenantId, slug, created: true }
}

/** Opens the configured database, applies migrations, and runs `initTenant`. */
export async function runInit(args: {
  env: Record<string, string | undefined>
  slug: string
  name: string
  origins: string[]
  log?: (line: string) => void
}): Promise<InitResult> {
  const log = args.log ?? ((line: string) => console.log(line))
  if (args.slug.trim().length === 0) throw new Error("a tenant slug is required")
  if (args.origins.length === 0) {
    // An empty allowlist means the widget is refused on every site, so a tenant created
    // without one would look broken rather than unconfigured. Failing here says which
    // flag is missing.
    throw new Error(
      "at least one --origin is required, e.g. --origin https://example.com\n" +
        "The widget is refused on any site not in this list, so a tenant without one " +
        "cannot answer anybody.",
    )
  }

  const config = readServeConfig(args.env)
  const db = await createDb(config.db)
  await applyMigrations(db)

  const result = await initTenant({ db, ...args })
  log(
    result.created
      ? `created tenant "${result.slug}" (${result.tenantId})`
      : `updated tenant "${result.slug}" (${result.tenantId})`,
  )
  log(`allowed origins: ${args.origins.join(", ")}`)
  log("")
  log("Paste this into the site you just allowed:")
  log("")
  log(`  <script src="/quidchat.js"`)
  log(`          data-quidchat-tenant="${result.slug}"`)
  log(`          defer></script>`)
  return result
}
