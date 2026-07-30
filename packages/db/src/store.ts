import type { Candidate, Segment, Store, TenantConfig } from "@quidchat/core"
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"
import { withTenant } from "./tenant.js"

/**
 * Menyeragamkan hasil `execute()` yang bentuknya BERBEDA antar driver:
 * driver PGlite mengembalikan objek ber-`rows`, sedangkan driver postgres-js
 * mengembalikan hasil `client.unsafe()` yang berupa Array (dengan properti
 * tambahan seperti `count` dan `command`, tapi TANPA `.rows`).
 *
 * Tanpa penyeragaman ini, mengakses `.rows` langsung akan bekerja di seluruh
 * test — yang memakai PGlite — lalu menghasilkan `undefined` di tier 3 yang
 * memakai postgres-js. Bug yang lolos setiap test dan hanya muncul di produksi.
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
        // TANPA `WHERE tenant_id` — dan itu wajib. RLS yang men-scope. Filter aplikasi
        // di sini akan mengembalikan baris yang benar bahkan ketika policy-nya sudah
        // runtuh, sehingga kebocoran isolasi lolos seluruh test dan baru terlihat di
        // produksi. Terbukti: policy bocor + filter ini = 7/7 test tetap hijau.
        const res = await tx.execute(sql`
          SELECT chat_model, rewrite_model, embedding_model, refusal_text, high_risk_topics
          FROM tenant_settings
        `)
        const row = rowsOf(res)[0]
        if (!row) throw new Error(`tenant_settings tidak ditemukan: ${tenantId}`)
        return {
          chatModel: row.chat_model as string,
          rewriteModel: row.rewrite_model as string,
          embeddingModel: row.embedding_model as string,
          refusalText: row.refusal_text as string,
          highRiskTopics: row.high_risk_topics as string[],
        }
      })
    },

    async searchChunks({ tenantId, query, embedding, limit }): Promise<Candidate[]> {
      const vec = `[${embedding.join(",")}]`
      return withTenant(db, tenantId, async (tx) => {
        // Hybrid: skor keyword (ts_rank) dan skor semantik (1 - cosine distance)
        // dijumlahkan dengan bobot setara, lalu diambil top-k.
        const res = await tx.execute(sql`
          SELECT c.id, c.content, d.title,
                 ts_rank(c.tsv, plainto_tsquery('simple', ${query})) AS kw,
                 1 - (c.embedding <=> ${vec}::vector)                AS sem
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          WHERE c.embedding IS NOT NULL
          ORDER BY (
            ts_rank(c.tsv, plainto_tsquery('simple', ${query}))
            + (1 - (c.embedding <=> ${vec}::vector))
          ) DESC
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
          // `tenant_id` WAJIB disertakan. Kolomnya `NOT NULL` tanpa default, dan
          // dua foreign key komposit tabel ini — (tenant_id, message_id) dan
          // (tenant_id, chunk_id) — memakainya untuk memastikan sebuah sitasi
          // tidak pernah bisa menunjuk baris milik tenant lain. Menghilangkannya
          // membuat setiap pemanggilan recordAnswer gagal.
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
  }
}
