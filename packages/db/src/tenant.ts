import { sql, type ExtractTablesWithRelations } from "drizzle-orm"
import type { PgliteTransaction } from "drizzle-orm/pglite"
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js"
import type { QuidDb } from "./client.js"
import type * as schema from "./schema.js"

type Relations = ExtractTablesWithRelations<typeof schema>

/**
 * The actual shape of `tx` inside the `db.transaction()` callback, for both
 * drivers. This is DELIBERATELY not `QuidDb`: `QuidDb` carries `$client`
 * (access to the raw connection), which doesn't mean anything inside a single
 * transaction. The query surface consumers use (`select`, `insert`, `update`,
 * `delete`, `execute`, etc.) is identical to `QuidDb`, so no functionality is
 * lost — only the property that genuinely doesn't apply here is left out.
 * Because the callback type no longer forces a `$client` that doesn't exist,
 * no cast or `@ts-expect-error` is needed anywhere.
 */
export type QuidTx =
  | PgliteTransaction<typeof schema, Relations>
  | PostgresJsTransaction<typeof schema, Relations>

/**
 * Runs `fn` inside a single transaction with the application role and tenant
 * context set. Both are `SET LOCAL`, so they're automatically released when
 * the transaction ends — no context leaks into the next query on the same
 * connection.
 *
 * This is the only path that makes RLS actually take effect (see the note on
 * `QuidDb`/`createDb`) — without it, queries run as superuser and see every
 * tenant, rather than failing or coming back empty.
 */
export async function withTenant<T>(
  db: QuidDb,
  tenantId: string,
  fn: (tx: QuidTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quidchat_app`)
    await tx.execute(sql`SELECT set_config('quidchat.tenant_id', ${tenantId}, true)`)
    // Iterative scan MUST be on precisely BECAUSE tenant isolation uses RLS.
    //
    // pgvector applies filters AFTER traversing the HNSW index, not during.
    // The RLS predicate `tenant_id = current_tenant_id()` is one of those
    // filters. With the default `hnsw.ef_search` of 40 and iterative scan
    // off, an `ORDER BY embedding <=> v LIMIT k` can return FEWER than k
    // rows — not because the data isn't there, but because the 40 rows the
    // index examined happened to belong to other tenants and got filtered
    // out afterward.
    //
    // The result is silent recall loss, and it's worst in exactly the case
    // that's most common in a multi-tenant system: one small tenant in a
    // large table, or a tenant mid-reindex with mixed `embedding_model`
    // values. No error, no log — just the assistant answering "sorry, I
    // don't have that information" when the document is actually there.
    //
    // `strict_order`, not `relaxed_order`: the RRF in `searchChunks` fuses
    // by RANK, so the ranking has to be correct. `hnsw.max_scan_tuples`
    // (default 20,000) is what keeps the scan from running away.
    //
    // Verified: this parameter is `user`-context, so it can be set by the
    // non-superuser `quidchat_app`, and `SET LOCAL` does correctly release it
    // when the transaction ends.
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`)
    return fn(tx)
  })
}
