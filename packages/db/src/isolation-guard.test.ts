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
import { withTenant } from "./tenant.js"
import { freshPglite } from "./testing.js"

/** Menyeragamkan hasil `execute()`: driver PGlite mengembalikan `{rows}`, postgres-js Array. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

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

  it("guard migrasi MENOLAK policy yang hanya MENYEBUT current_tenant_id()", async () => {
    // Serangan yang mengalahkan versi kedua guard. `USING (current_tenant_id() IS NOT NULL)`
    // menyebut fungsinya tanpa membatasi satu baris pun, jadi pemeriksaan "mengandung"
    // lolos sementara tabelnya terbuka penuh. Pemeriksaan substring tidak akan pernah
    // bisa membuktikan sebuah policy membatasi — guard-nya sekarang menuntut ekspresi
    // yang PERSIS, dan test ini yang menjaganya tetap begitu.
    await db.execute(
      sql`CREATE POLICY leak_menyebut ON conversations USING (current_tenant_id() IS NOT NULL)`,
    )
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY leak_menyebut ON conversations`)
  })
})

/**
 * Test PERILAKU, bukan analisis teks.
 *
 * Guard di migrasi memeriksa BENTUK policy. Berkas ini memeriksa AKIBATNYA: untuk
 * SETIAP tabel ber-`tenant_id`, jumlah baris yang dilihat satu tenant di dalam
 * `withTenant` wajib sama dengan jumlah baris yang benar-benar miliknya.
 *
 * Ini menangkap cacat policy apa pun — ditulis dengan cara apa pun, pada tabel apa pun,
 * sekarang atau nanti — termasuk cacat yang tidak terpikirkan saat guard-nya ditulis.
 * Dua serangan yang berhasil mengalahkan dua versi guard sebelumnya keduanya tertangkap
 * di sini tanpa perlu diantisipasi lebih dulu.
 */
describe("isolasi setiap tabel, diukur dari perilakunya", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let idA: string

  /** Mengisi SEMUA tabel ber-`tenant_id` untuk satu tenant, menghormati urutan FK. */
  async function isiPenuh(tenantId: string, tanda: string) {
    const satu = async (q: ReturnType<typeof sql>) =>
      rowsOf(await db.execute(q))[0]!.id as string

    await db.execute(sql`INSERT INTO tenant_settings (tenant_id) VALUES (${tenantId})`)
    const userId = await satu(sql`
      INSERT INTO admin_users (tenant_id, email, password_hash)
      VALUES (${tenantId}, ${`${tanda}@contoh.id`}, 'x') RETURNING id
    `)
    await db.execute(sql`
      INSERT INTO admin_sessions (tenant_id, admin_user_id, expires_at)
      VALUES (${tenantId}, ${userId}, now() + interval '1 day')
    `)
    const sourceId = await satu(sql`
      INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
      VALUES (${tenantId}, 'text', ${`${tanda}.txt`}, 'ready') RETURNING id
    `)
    const docId = await satu(sql`
      INSERT INTO documents (tenant_id, source_id, title)
      VALUES (${tenantId}, ${sourceId}, ${`Dokumen ${tanda}`}) RETURNING id
    `)
    const chunkId = await satu(sql`
      INSERT INTO chunks (tenant_id, document_id, ordinal, content, embedding_model)
      VALUES (${tenantId}, ${docId}, 0, ${`isi milik ${tanda}`}, 'test') RETURNING id
    `)
    const convId = await satu(sql`
      INSERT INTO conversations (tenant_id, channel, visitor_id)
      VALUES (${tenantId}, 'widget', ${`v-${tanda}`}) RETURNING id
    `)
    const msgId = await satu(sql`
      INSERT INTO messages (tenant_id, conversation_id, role, content)
      VALUES (${tenantId}, ${convId}, 'assistant', ${`jawaban ${tanda}`}) RETURNING id
    `)
    await db.execute(sql`
      INSERT INTO message_citations (tenant_id, message_id, chunk_id)
      VALUES (${tenantId}, ${msgId}, ${chunkId})
    `)
    await db.execute(sql`
      INSERT INTO escalations (tenant_id, conversation_id, reason)
      VALUES (${tenantId}, ${convId}, 'no_source')
    `)
    await db.execute(sql`
      INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, cost_cents)
      VALUES (${tenantId}, 'test', 10, 5, 1)
    `)
  }

  beforeAll(async () => {
    db = await freshPglite()
    const r = await db.execute(sql`
      INSERT INTO tenants (slug, name) VALUES ('a', 'A'), ('b', 'B') RETURNING id
    `)
    const ids = rowsOf(r).map((x) => x.id as string)
    idA = ids[0]!
    // KEDUA tenant diisi. Satu tenant saja membuat setiap tabel "aman" secara hampa:
    // tidak ada data orang lain yang bisa bocor, jadi tidak ada yang dibuktikan.
    await isiPenuh(ids[0]!, "a")
    await isiPenuh(ids[1]!, "b")
  })

  it("setiap tabel ber-tenant_id hanya memperlihatkan baris milik tenant itu", async () => {
    const tabel = rowsOf(
      await db.execute(sql`
        SELECT c.relname AS nama
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
          )
        ORDER BY c.relname
      `),
    ).map((x) => x.nama as string)

    const bocor: string[] = []
    const hampa: string[] = []

    for (const t of tabel) {
      // Kebenaran diambil lewat raw handle, yang memang melewati RLS dengan sengaja.
      const milikA = Number(
        rowsOf(
          await db.execute(
            sql.raw(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = '${idA}'`),
          ),
        )[0]!.n,
      )
      const terlihat = await withTenant(db, idA, async (tx) =>
        Number(rowsOf(await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`)))[0]!.n),
      )
      if (milikA === 0) hampa.push(t)
      if (terlihat !== milikA) bocor.push(`${t}: terlihat ${terlihat}, milik tenant ${milikA}`)
    }

    expect(bocor).toEqual([])
    // Tabel tanpa data milik A tidak membuktikan apa pun. Assertion ini yang mencegah
    // test ini melemah tanpa suara kalau suatu hari `isiPenuh` berhenti mengisi sesuatu.
    expect(hampa).toEqual([])
    expect(tabel.length).toBeGreaterThanOrEqual(11)
  })
})
