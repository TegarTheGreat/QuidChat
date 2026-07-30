import type { Candidate, Segment, Store, TenantConfig } from "@quidchat/core"
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"
import { withTenant } from "./tenant.js"

/**
 * Normalizes the `execute()` result, whose shape DIFFERS between drivers:
 * the PGlite driver returns an object with `rows`, while the postgres-js
 * driver returns the result of `client.unsafe()`, which is an Array (with
 * extra properties like `count` and `command`, but WITHOUT `.rows`).
 *
 * Without this normalization, accessing `.rows` directly would work across
 * the entire test suite — which uses PGlite — and then produce `undefined`
 * in tier 3, which uses postgres-js. A bug that passes every test and only
 * shows up in production.
 */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export function createStore(db: QuidDb): Store {
  return {
    async getTenantConfig(tenantId: string): Promise<TenantConfig> {
      return withTenant(db, tenantId, async (tx) => {
        // NO `WHERE tenant_id` here — and that's required. RLS does the scoping. An
        // application-level filter here would return the correct row even when the
        // policy has collapsed, so an isolation leak would pass every test and only
        // become visible in production. Proven: a leaky policy plus this filter left
        // 7/7 tests green.
        const res = await tx.execute(sql`
          SELECT chat_model, rewrite_model, embedding_model, refusal_text, high_risk_topics
          FROM tenant_settings
        `)
        const rows = rowsOf(res)
        if (rows.length === 0) throw new Error(`tenant_settings not found: ${tenantId}`)
        // More than one row means RLS is NOT isolating — under a correct policy, a
        // `SELECT` with no `WHERE` inside withTenant() can only ever see one row.
        // Silently taking the first row would mean reading another tenant's settings,
        // and because every tenant's defaults are identical, no test would notice.
        if (rows.length > 1) {
          throw new Error(
            `tenant isolation failed: tenant_settings returned ${rows.length} rows for a single tenant`,
          )
        }
        const row = rows[0]!
        return {
          chatModel: row.chat_model as string,
          rewriteModel: row.rewrite_model as string,
          embeddingModel: row.embedding_model as string,
          refusalText: row.refusal_text as string,
          highRiskTopics: row.high_risk_topics as string[],
        }
      })
    },

    async searchChunks({ tenantId, query, embedding, embeddingModel, limit }): Promise<Candidate[]> {
      const vec = `[${embedding.join(",")}]`
      // The per-path pool is made larger than `limit` so the fusion has material to
      // work with; 20 as a floor so a small limit doesn't narrow the candidate set.
      const poolSize = Math.max(limit * 4, 20)
      return withTenant(db, tenantId, async (tx) => {
        // Reciprocal Rank Fusion. Both paths are taken top-k INDEPENDENTLY and then
        // combined by RANK, not by raw score.
        //
        // Summing raw scores can't be used: ts_rank for a single-word match is about
        // 0.0608 while (1 - cosine) spans [-1, 1]. Measured on PGlite, a chunk that
        // DOES contain the keyword lost to a chunk that doesn't contain it at all.
        // RRF doesn't care about scale — only order — so both paths get real weight.
        //
        // Important side effect: the `sem` CTE uses the form
        // `ORDER BY embedding <=> vec LIMIT k`, the only form that CAN use the HNSW
        // index. The old version, which ordered by the sum of the two scores, could
        // never use it.
        //
        // "Can", not "will", and the difference matters. pgvector applies filters
        // AFTER traversing the index — so the `embedding_model` filter below AND the
        // RLS `tenant_id` predicate are both post-scan. Left unhandled, that means
        // silent recall loss: the index checks `ef_search` rows, the filters discard
        // most of them, and the result comes back under `poolSize` with no error at
        // all. That's why `withTenant` turns on `hnsw.iterative_scan = strict_order` —
        // see the full reasoning there. Whether the planner actually picks the index
        // at production scale hasn't been measured; the small-table tests on PGlite
        // always pick a sequential scan because it's genuinely cheaper there.
        const res = await tx.execute(sql`
          WITH kw AS (
            SELECT c.id,
                   row_number() OVER (
                     ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', ${query})) DESC, c.id
                   ) AS rnk
            FROM chunks c
            WHERE c.tsv @@ plainto_tsquery('simple', ${query})
            ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', ${query})) DESC, c.id
            LIMIT ${poolSize}
          ),
          sem AS (
            SELECT c.id,
                   row_number() OVER (ORDER BY c.embedding <=> ${vec}::vector, c.id) AS rnk
            FROM chunks c
            WHERE c.embedding IS NOT NULL
              AND c.embedding_model = ${embeddingModel}
            ORDER BY c.embedding <=> ${vec}::vector, c.id
            LIMIT ${poolSize}
          ),
          fused AS (
            -- RRF constant = 10, NOT the 60 from the original paper. The reason is
            -- arithmetic, not taste.
            --
            -- The maximum score for a chunk that appears in only ONE list is 1/(k+1).
            -- The minimum score for a chunk that appears in BOTH lists is 2/(k+pool).
            -- With k=60 and pool=32: 0.01639 < 0.02174 — so a chunk present in both
            -- lists beats EVERY single-list chunk, no matter how good its match is.
            --
            -- That's not just suboptimal, it's a structural exclusion: chunks with
            -- 'embedding IS NULL' and chunks still on an old embedding model CANNOT
            -- enter the 'sem' list, so they are permanently single-list. Measured: one
            -- answering chunk without an embedding, among 12 irrelevant chunks that do
            -- have embeddings, fell to rank 4; with >=8 dual-list chunks it drops out of
            -- the candidate window and the pipeline REFUSES even though the answer
            -- exists.
            --
            -- The requirement is k < pool − 2. Since poolSize = max(limit*4, 20), the
            -- pool can be as small as 20, so k must be < 18. k=10 satisfies the whole
            -- range (0.09091 > 0.04762) and STILL makes presence in both lists
            -- advantageous (0.18182 > 0.09091) — just no longer absolute.
            SELECT id, SUM(1.0 / (10 + rnk)) AS score
            FROM (SELECT id, rnk FROM kw UNION ALL SELECT id, rnk FROM sem) u
            GROUP BY id
          )
          SELECT c.id, c.content, d.title, f.score
          FROM fused f
          JOIN chunks c ON c.id = f.id
          JOIN documents d ON d.id = c.document_id
          ORDER BY f.score DESC, c.id
          LIMIT ${limit}
        `)
        return rowsOf(res).map((r) => ({
          id: r.id as string,
          content: r.content as string,
          documentTitle: r.title as string,
        }))
      })
    },

    async recordAnswer({ tenantId, conversationId, segments, citedChunkIds }) {
      const text = segments.map((s: Segment) => s.text).join(" ")
      await withTenant(db, tenantId, async (tx) => {
        const res = await tx.execute(sql`
          INSERT INTO messages (tenant_id, conversation_id, role, content)
          VALUES (${tenantId}, ${conversationId}, 'assistant', ${text})
          RETURNING id
        `)
        const messageId = rowsOf(res)[0]!.id as string
        for (const chunkId of citedChunkIds) {
          // `tenant_id` MUST be included. The column is `NOT NULL` with no default,
          // and this table's two composite foreign keys — (tenant_id, message_id) and
          // (tenant_id, chunk_id) — use it to guarantee a citation can never point at
          // a row belonging to another tenant. Omitting it makes every call to
          // recordAnswer fail.
          await tx.execute(sql`
            INSERT INTO message_citations (tenant_id, message_id, chunk_id)
            VALUES (${tenantId}, ${messageId}, ${chunkId})
          `)
        }
      })
    },

    async recordEscalation({ tenantId, conversationId, reason }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO escalations (tenant_id, conversation_id, reason)
          VALUES (${tenantId}, ${conversationId}, ${reason})
        `)
      })
    },

    async recordUserTurn({ tenantId, conversationId, text }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO messages (tenant_id, conversation_id, role, content)
          VALUES (${tenantId}, ${conversationId}, 'user', ${text})
        `)
      })
    },

    async createDocument({ tenantId, sourceId, title, url }): Promise<string> {
      return withTenant(db, tenantId, async (tx) => {
        const res = await tx.execute(sql`
          INSERT INTO documents (tenant_id, source_id, title, url)
          VALUES (${tenantId}, ${sourceId}, ${title}, ${url ?? null})
          RETURNING id
        `)
        return rowsOf(res)[0]!.id as string
      })
    },

    async insertChunks({ tenantId, documentId, chunks }) {
      await withTenant(db, tenantId, async (tx) => {
        for (const chunk of chunks) {
          // NULL for a missing embedding is deliberate — see the `insertChunks` doc
          // comment on `Store`. `NULL::vector` is a valid cast in Postgres, so this
          // does not need special-casing beyond skipping the `[...]` formatting.
          const vec = chunk.embedding ? `[${chunk.embedding.join(",")}]` : null
          await tx.execute(sql`
            INSERT INTO chunks (tenant_id, document_id, ordinal, content, embedding, embedding_model)
            VALUES (
              ${tenantId}, ${documentId}, ${chunk.ordinal}, ${chunk.content},
              ${vec}::vector, ${chunk.embeddingModel}
            )
          `)
        }
      })
    },

    async setSourceStatus({ tenantId, sourceId, status, error }) {
      await withTenant(db, tenantId, async (tx) => {
        // No `WHERE tenant_id` here, same as everywhere else in this file — RLS scopes
        // the update via the transaction's tenant context. Filtering by `id` alone is
        // not a tenant filter: it just selects the one row this call means to touch.
        await tx.execute(sql`
          UPDATE knowledge_sources
          SET status = ${status},
              error = ${error ?? null},
              last_indexed_at = CASE WHEN ${status} = 'ready' THEN now() ELSE last_indexed_at END
          WHERE id = ${sourceId}
        `)
      })
    },
  }
}
