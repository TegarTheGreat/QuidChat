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
        const rows = rowsOf(res)
        if (rows.length === 0) throw new Error(`tenant_settings tidak ditemukan: ${tenantId}`)
        // Lebih dari satu baris berarti RLS sedang TIDAK mengisolasi — di bawah policy yang
        // benar, `SELECT` tanpa `WHERE` di dalam withTenant() hanya bisa melihat satu baris.
        // Mengambil baris pertama secara diam-diam berarti membaca setelan tenant lain, dan
        // karena setelan default setiap tenant identik, tidak ada test yang akan menyadarinya.
        if (rows.length > 1) {
          throw new Error(
            `isolasi tenant gagal: tenant_settings mengembalikan ${rows.length} baris untuk satu tenant`,
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
      // Kolam per jalur dibuat lebih besar dari `limit` supaya fusi punya bahan;
      // 20 sebagai dasar agar limit kecil tidak mempersempit kandidatnya.
      const poolSize = Math.max(limit * 4, 20)
      return withTenant(db, tenantId, async (tx) => {
        // Reciprocal Rank Fusion. Kedua jalur diambil top-k SENDIRI-SENDIRI lalu
        // digabung berdasarkan PERINGKAT, bukan berdasarkan skor mentah.
        //
        // Menjumlahkan skor mentah tidak bisa dipakai: ts_rank untuk kecocokan satu kata
        // sekitar 0,06 sementara (1 - cosine) berkisar [-1, 1]. Diukur di PGlite, chunk
        // yang MEMUAT kata kuncinya kalah dari chunk yang tidak memuatnya sama sekali.
        // RRF tidak peduli skala — hanya urutan — jadi kedua jalur benar-benar berbobot.
        //
        // Efek samping yang penting: CTE `sem` memakai bentuk
        // `ORDER BY embedding <=> vec LIMIT k`, satu-satunya bentuk yang bisa memakai
        // indeks HNSW. Versi lama yang mengurutkan berdasarkan jumlah dua skor tidak
        // pernah bisa memakainya.
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
            SELECT id, SUM(1.0 / (60 + rnk)) AS score
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
