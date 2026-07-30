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
 * Handle Drizzle mentah, tidak terikat tenant mana pun. Query lewat sini
 * langsung ke tabel-tabel ber-`tenant_id` (mis. `db.select().from(chunks)`)
 * mengembalikan baris milik SEMUA tenant, bukan nol dan bukan gagal — RLS
 * tidak melindunginya sama sekali. Satu-satunya jalan yang membuat isolasi
 * tenant benar-benar berlaku adalah `withTenant`; pakai handle mentah ini
 * hanya untuk tiga hal yang memang sengaja lintas-tenant: menerapkan migrasi,
 * seeding di test, dan pekerjaan administratif yang sengaja butuh akses ke
 * semua tenant sekaligus. Setiap baca atau tulis lain ke tabel ber-tenant
 * WAJIB lewat `withTenant`.
 */
export type QuidDb =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>

/**
 * Membuat handle mentah (lihat catatan pada `QuidDb`). Untuk `kind: "pglite"`
 * koneksinya selalu superuser `postgres`, yang melewati RLS tanpa syarat.
 * Untuk `kind: "postgres"`, `url` WAJIB mengautentikasi sebagai role yang
 * BUKAN superuser dan TIDAK punya atribut `BYPASSRLS` — migrasi menyediakan
 * `quidchat_app` untuk keperluan ini. Kalau `url` menghubungkan sebagai
 * superuser atau role ber-`BYPASSRLS`, perilaku fail-closed (nol baris tanpa
 * konteks tenant) tidak berlaku, dan kebocoran lintas-tenant yang sama seperti
 * PGlite akan terjadi juga di Postgres sungguhan.
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
