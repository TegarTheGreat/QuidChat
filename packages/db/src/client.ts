import { PGlite } from "@electric-sql/pglite"
import { vector } from "@electric-sql/pglite-pgvector"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export type DbConfig =
  | { kind: "pglite"; dataDir?: string }
  | { kind: "postgres"; url: string }

/**
 * Raw Drizzle handle, not bound to any tenant. Queries made directly through
 * this against `tenant_id`-bearing tables (e.g. `db.select().from(chunks)`)
 * return rows belonging to ALL tenants — not zero, not an error — because RLS
 * offers it no protection at all. The only path that actually enforces tenant
 * isolation is `withTenant`; use this raw handle only for the three things
 * that are deliberately cross-tenant: applying migrations, seeding in tests,
 * and administrative work that genuinely needs access to every tenant at
 * once. Every other read or write to a tenant-scoped table MUST go through
 * `withTenant`.
 */
export type QuidDb =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>

/**
 * `url` is for tier 3. The role used to connect MUST be a member of
 * `quidchat_app` — migrations try to grant this automatically; if your
 * environment doesn't allow that, run `GRANT quidchat_app TO <role>` as
 * superuser at deploy time.
 *
 * Connecting as superuser does NOT defeat isolation on the `withTenant` path:
 * `SET LOCAL ROLE quidchat_app` demotes `current_user`, so RLS still applies —
 * this is proven by the isolation tests, which run on PGlite as the `postgres`
 * superuser. What DOES bypass RLS is only the raw handle (`db` used directly,
 * without `withTenant`), regardless of role. That is deliberate, for
 * migrations and onboarding new tenants.
 */
export async function createDb(config: DbConfig): Promise<QuidDb> {
  if (config.kind === "pglite") {
    const client = config.dataDir
      ? await PGlite.create(config.dataDir, { extensions: { vector } })
      : await PGlite.create({ extensions: { vector } })
    return drizzlePglite(client, { schema })
  }
  return drizzlePostgres(postgres(config.url, { max: 10 }), { schema })
}
