/**
 * Test yang MENYERANG isolasi tenant, lalu menuntut pertahanannya berbunyi.
 *
 * Review akhir Rencana 1 menemukan cacatnya bukan dengan membaca kode, tapi dengan
 * merusaknya dan melihat suite tetap hijau. Serangan yang dipakai: menambahkan
 * `CREATE POLICY leak ON tenant_settings USING (true)` DI SAMPING policy yang men-scope.
 * Postgres menggabungkan policy permissive dengan OR, jadi isolasinya runtuh sementara
 * policy yang benar tetap ada — dan waktu itu NOL test gagal.
 *
 * Berkas ini menjadikan serangan itu bagian permanen dari suite. Ada dua pertahanan dan
 * keduanya diuji terhadap serangan yang sama:
 *
 *   1. Guard di migrasi, yang menolak SETIAP policy permissive yang tidak menyebut
 *      `current_tenant_id()`. Guard-nya DIEKSTRAK LANGSUNG dari berkas migrasi, bukan
 *      disalin ke sini — kalau seseorang melemahkan guard-nya, test ini yang gagal.
 *   2. `getTenantConfig`, yang menolak hasil lebih dari satu baris. Tanpa itu, kode
 *      diam-diam mengambil baris pertama, yang bisa milik tenant lain — dan karena
 *      setelan default setiap tenant identik di instalasi baru, tidak ada assertion
 *      biasa yang akan menyadarinya.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { tenants, tenantSettings } from "./schema.js"
import { createStore } from "./store.js"
import { freshPglite } from "./testing.js"

/** Mengambil satu blok `DO $nama$ ... END $nama$;` dari berkas migrasi yang terkirim. */
function blokGuard(nama: string): string {
  const migrasi = readFileSync(
    join(process.cwd(), "packages/db/migrations/0001_init.sql"),
    "utf8",
  )
  const buka = `DO $${nama}$`
  const tutup = `END $${nama}$;`
  const mulai = migrasi.indexOf(buka)
  if (mulai === -1) throw new Error(`blok ${buka} tidak ada di migrasi`)
  return migrasi.slice(mulai, migrasi.indexOf(tutup, mulai) + tutup.length)
}

describe("isolasi tenant di bawah serangan", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let tenantA: string
  let guard: string

  beforeAll(async () => {
    db = await freshPglite()
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A" }).returning()
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B" }).returning()
    tenantA = a!.id
    // Dua tenant, keduanya punya setelan. Satu tenant saja tidak cukup: kebocoran
    // hanya terlihat kalau ada data tenant lain yang bisa bocor.
    await db.insert(tenantSettings).values({ tenantId: a!.id })
    await db.insert(tenantSettings).values({ tenantId: b!.id })
    guard = blokGuard("guard2")
  })

  it("guard migrasi lolos pada skema yang sehat", async () => {
    await expect(db.execute(sql.raw(guard))).resolves.toBeDefined()
  })

  it("getTenantConfig bekerja normal pada skema yang sehat", async () => {
    const cfg = await createStore(db).getTenantConfig(tenantA)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
  })

  it("guard migrasi MENOLAK policy bocor yang ditambahkan berdampingan", async () => {
    await db.execute(sql`CREATE POLICY leak ON tenant_settings USING (true)`)
    // Kalau assertion ini gagal, guard-nya sudah dilemahkan dan kebocoran isolasi
    // bisa mendarat lewat migrasi tanpa ada yang menyadarinya.
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
  })

  it("getTenantConfig MELEMPAR alih-alih membaca setelan tenant lain", async () => {
    // Policy bocor dari test sebelumnya masih terpasang; itu memang yang diuji.
    await expect(createStore(db).getTenantConfig(tenantA)).rejects.toThrow(
      "isolasi tenant gagal",
    )
    await db.execute(sql`DROP POLICY leak ON tenant_settings`)
  })
})
