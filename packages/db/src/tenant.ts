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
    return fn(tx)
  })
}
