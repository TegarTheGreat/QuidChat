import { sql, type ExtractTablesWithRelations } from "drizzle-orm"
import type { PgliteTransaction } from "drizzle-orm/pglite"
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js"
import type { QuidDb } from "./client.js"
import type * as schema from "./schema.js"

type Relations = ExtractTablesWithRelations<typeof schema>

/**
 * Bentuk `tx` yang sesungguhnya di dalam callback `db.transaction()`, untuk
 * kedua driver. Ini SENGAJA bukan `QuidDb`: `QuidDb` membawa `$client` (akses
 * ke koneksi mentah), sesuatu yang tidak berarti di dalam satu transaksi.
 * Permukaan query yang dipakai konsumen (`select`, `insert`, `update`,
 * `delete`, `execute`, dst) sama persis dengan `QuidDb`, jadi tidak ada
 * fungsionalitas yang hilang — hanya properti yang memang tidak relevan di
 * sini yang tidak ikut. Karena tipe callback tidak lagi memaksakan `$client`
 * yang tidak ada, tidak diperlukan cast atau `@ts-expect-error` sama sekali.
 */
export type QuidTx =
  | PgliteTransaction<typeof schema, Relations>
  | PostgresJsTransaction<typeof schema, Relations>

/**
 * Menjalankan `fn` di dalam satu transaksi dengan role aplikasi dan konteks
 * tenant terpasang. Keduanya `SET LOCAL`, jadi otomatis lepas saat transaksi
 * selesai — tidak ada kebocoran konteks ke query berikutnya di koneksi yang sama.
 *
 * Ini satu-satunya jalan yang membuat RLS benar-benar berlaku (lihat catatan
 * pada `QuidDb`/`createDb`) — tanpanya, query jalan sebagai superuser dan
 * melihat semua tenant, bukan gagal atau kosong.
 */
export async function withTenant<T>(
  db: QuidDb,
  tenantId: string,
  fn: (tx: QuidTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quidchat_app`)
    await tx.execute(sql`SELECT set_config('quidchat.tenant_id', ${tenantId}, true)`)
    // Iterative scan WAJIB aktif justru KARENA isolasi tenant memakai RLS.
    //
    // pgvector menerapkan filter SETELAH penelusuran indeks HNSW, bukan selama.
    // Predikat RLS `tenant_id = current_tenant_id()` adalah salah satu filter itu.
    // Dengan `hnsw.ef_search` default 40 dan iterative scan mati, sebuah
    // `ORDER BY embedding <=> v LIMIT k` bisa mengembalikan LEBIH SEDIKIT dari k
    // baris — bukan karena datanya tidak ada, tapi karena 40 baris yang diperiksa
    // indeks kebetulan milik tenant lain dan tersaring habis setelahnya.
    //
    // Akibatnya kehilangan recall yang SUNYI, dan justru paling parah pada kasus
    // yang paling wajar di sistem multi-tenant: satu tenant kecil di tabel besar,
    // atau tenant yang sedang re-index sehingga `embedding_model`-nya bercampur.
    // Tidak ada error, tidak ada log — hanya asisten yang menjawab "maaf, belum ada
    // informasi itu" padahal dokumennya ada.
    //
    // `strict_order`, bukan `relaxed_order`: RRF di `searchChunks` memfusikan
    // berdasarkan PERINGKAT, jadi peringkatnya harus benar. `hnsw.max_scan_tuples`
    // (default 20.000) yang membatasi agar penelusurannya tidak liar.
    //
    // Diverifikasi: parameter ini ber-konteks `user`, jadi bisa disetel oleh
    // `quidchat_app` yang bukan superuser, dan `SET LOCAL` benar lepas saat
    // transaksi selesai.
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`)
    return fn(tx)
  })
}
