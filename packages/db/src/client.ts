import { mkdir } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm"
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
    if (config.dataDir) {
      // PGlite creates the leaf directory but not its parents, so the default
      // `./.quidchat/data` fails with ENOENT on a first run in a fresh project — the very
      // first command a new user types. `recursive` also makes an existing directory a
      // no-op, which is what every run after the first one needs.
      await mkdir(config.dataDir, { recursive: true })
    }
    const client = config.dataDir
      ? await PGlite.create(config.dataDir, { extensions: { vector, pg_trgm } })
      : await PGlite.create({ extensions: { vector, pg_trgm } })
    return drizzlePglite(client, { schema })
  }
  return drizzlePostgres(postgres(config.url, { max: 10 }), { schema })
}

/**
 * A consistent copy of the whole database, as bytes.
 *
 * PGlite is a directory of files, and copying that directory while the server has it open is how
 * a backup ends up unrestorable in exactly the case someone needs it. Its own dump reads through
 * the running engine instead, which is the difference between a copy and a snapshot.
 *
 * Returns null for a managed Postgres, where the answer is `pg_dump` against the same URL — a
 * tool that already exists, is already what an operator's provider documents, and would be worse
 * for being wrapped.
 */
export async function dumpDatabase(db: QuidDb): Promise<Uint8Array | null> {
  const client: unknown = (db as { $client?: unknown }).$client
  if (!(client instanceof PGlite)) return null
  const blob = await client.dumpDataDir("gzip")
  return new Uint8Array(await blob.arrayBuffer())
}
