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
 * `url` untuk tier 3. Role yang dipakai konek WAJIB jadi anggota `quidchat_app` —
 * migrasi berusaha memberikannya otomatis; kalau environment-mu tidak mengizinkan,
 * jalankan `GRANT quidchat_app TO <role>` sebagai superuser saat deploy.
 *
 * Konek sebagai superuser TIDAK membatalkan isolasi di jalur `withTenant`:
 * `SET LOCAL ROLE quidchat_app` menurunkan `current_user`, jadi RLS tetap berlaku —
 * ini dibuktikan test isolasi, yang berjalan di PGlite sebagai superuser `postgres`.
 * Yang MEMANG melewati RLS hanyalah raw handle (`db` langsung, tanpa `withTenant`),
 * apa pun role-nya. Itu disengaja untuk migrasi dan onboarding tenant baru.
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
