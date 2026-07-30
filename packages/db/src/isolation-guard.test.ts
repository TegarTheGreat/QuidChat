/**
 * Test yang MENYERANG isolasi tenant, lalu menuntut pertahanannya berbunyi.
 *
 * Review akhir Rencana 1 menemukan cacatnya bukan dengan membaca kode, tapi dengan
 * merusaknya dan melihat suite tetap hijau. Serangan pertama yang dipakai: menambahkan
 * `CREATE POLICY leak ON tenant_settings USING (true)` DI SAMPING policy yang men-scope.
 * Postgres menggabungkan policy permissive dengan OR, jadi isolasinya runtuh sementara
 * policy yang benar tetap ada — dan waktu itu NOL test gagal. Review Rencana 2 menemukan
 * dua serangan lagi dengan cara yang sama, keduanya lolos dari versi guard saat itu (lihat
 * `describe` kedua di bawah).
 *
 * Berkas ini menjadikan serangan-serangan itu bagian permanen dari suite. Ada tiga
 * pertahanan:
 *
 *   1. Guard di migrasi (blok `guard_isolasi`), yang menolak SETIAP tabel ber-RLS yang
 *      policy permissive-nya — pada `qual` maupun `with_check` — bukan PERSIS
 *      `(kunci = current_tenant_id())`. Guard-nya DIEKSTRAK LANGSUNG dari berkas migrasi,
 *      bukan disalin ke sini — kalau seseorang melemahkan guard-nya, test ini yang gagal.
 *   2. `getTenantConfig`, yang menolak hasil lebih dari satu baris. Tanpa itu, kode
 *      diam-diam mengambil baris pertama, yang bisa milik tenant lain — dan karena
 *      setelan default setiap tenant identik di instalasi baru, tidak ada assertion
 *      biasa yang akan menyadarinya.
 *   3. Test perilaku di `describe` kedua, yang mengukur akibat lewat query sungguhan,
 *      bukan bentuk teks policy — lihat docstring-nya untuk cakupan persisnya.
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
    guard = blokGuard("guard_isolasi")
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

  it("guard MENOLAK with_check yang dibocorkan — jalur TULIS", async () => {
    // Versi guard sebelumnya hanya memeriksa `qual`, yaitu jalur BACA. Dengan
    // `WITH CHECK (true)` sebuah tenant bisa MENULIS baris milik tenant lain:
    // terukur, satu baris usage_events 500.000 sen masuk ke buku besar orang lain,
    // dan satu pesan assistant palsu masuk ke transkrip bisnis lain.
    await db.execute(sql`DROP POLICY tenant_isolation ON usage_events`)
    await db.execute(sql`
      CREATE POLICY tenant_isolation ON usage_events
      USING (tenant_id = current_tenant_id()) WITH CHECK (true)
    `)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY tenant_isolation ON usage_events`)
    await db.execute(sql`
      CREATE POLICY tenant_isolation ON usage_events
      USING (tenant_id = current_tenant_id())
    `)
  })

  it("guard MENOLAK policy tenants yang dibocorkan", async () => {
    // `tenants` berkunci `id`, bukan `tenant_id`, jadi ia luput dari SETIAP lapis
    // pertahanan versi sebelumnya. Membocorkannya membuat seluruh daftar pelanggan
    // bisa dibaca tenant mana pun.
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (true)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id())`)
  })

  it("guard MENOLAK RLS yang dimatikan", async () => {
    // Mematok bagian guard yang memeriksa aktif+forced. Di versi sebelumnya bagian ini
    // ada di blok terpisah yang tidak dipanggil test mana pun, jadi menghapusnya
    // meninggalkan 44/44 hijau.
    await db.execute(sql`ALTER TABLE chunks DISABLE ROW LEVEL SECURITY`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`ALTER TABLE chunks ENABLE ROW LEVEL SECURITY`)
    await db.execute(sql`ALTER TABLE chunks FORCE ROW LEVEL SECURITY`)
  })
})

/**
 * Test PERILAKU, bukan analisis teks.
 *
 * Guard di migrasi memeriksa BENTUK policy. Berkas ini mengukur AKIBATNYA: untuk SETIAP
 * tabel yang dilindungi RLS — dienumerasi lewat `relrowsecurity`, bukan lewat keberadaan
 * kolom `tenant_id`, jadi `tenants` ikut terhitung — jumlah baris yang terlihat satu
 * tenant di dalam `withTenant` wajib sama dengan jumlah baris yang benar-benar
 * miliknya (jalur BACA), dan upaya menanam baris berkunci tenant lain wajib ditolak
 * (jalur TULIS).
 *
 * Yang TIDAK dicakup: view, fungsi `SECURITY DEFINER`, dan kode aplikasi yang memakai
 * raw handle (koneksi tanpa lewat `withTenant`) sama sekali tidak diperiksa di sini.
 * Cakupannya berhenti pada tabel ber-RLS yang diakses lewat `withTenant` — bukan
 * jaminan menyeluruh atas cacat policy apa pun di mana pun.
 */
describe("isolasi setiap tabel, diukur dari perilakunya", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let idA: string
  let idB: string

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
    idB = ids[1]!
    // KEDUA tenant diisi. Satu tenant saja membuat setiap tabel "aman" secara hampa:
    // tidak ada data orang lain yang bisa bocor, jadi tidak ada yang dibuktikan.
    await isiPenuh(ids[0]!, "a")
    await isiPenuh(ids[1]!, "b")
  })

  /** Semua tabel yang dilindungi RLS, beserta kunci tenant masing-masing. */
  async function tabelBerRls(): Promise<{ nama: string; kunci: string }[]> {
    const r = await db.execute(sql`
      SELECT c.relname AS nama,
             CASE WHEN EXISTS (
               SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public' AND col.table_name = c.relname
                 AND col.column_name = 'tenant_id'
             ) THEN 'tenant_id' ELSE 'id' END AS kunci
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname
    `)
    return rowsOf(r).map((x) => ({ nama: x.nama as string, kunci: x.kunci as string }))
  }

  it("setiap tabel ber-RLS hanya memperlihatkan baris milik tenant itu", async () => {
    const tabel = await tabelBerRls()
    const bocor: string[] = []
    const hampa: string[] = []
    for (const { nama, kunci } of tabel) {
      const milik = Number(
        rowsOf(
          await db.execute(
            sql.raw(`SELECT count(*)::int AS n FROM ${nama} WHERE ${kunci} = '${idA}'`),
          ),
        )[0]!.n,
      )
      const terlihat = await withTenant(db, idA, async (tx) =>
        Number(rowsOf(await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${nama}`)))[0]!.n),
      )
      if (milik === 0) hampa.push(nama)
      if (terlihat !== milik) bocor.push(`${nama}: terlihat ${terlihat}, milik ${milik}`)
    }
    expect(bocor).toEqual([])
    expect(hampa).toEqual([])
    // 12, bukan 11: `tenants` sekarang ikut. Angka ini yang membuat kelalaian
    // enumerasi terlihat kalau suatu saat ada tabel yang tidak ber-RLS.
    expect(tabel).toHaveLength(12)
  })

  it("withTenant menyalakan iterative scan, karena RLS menyaring setelah index scan", async () => {
    // Tanpa ini, `ORDER BY embedding <=> v LIMIT k` bisa mengembalikan kurang dari k
    // baris untuk tenant kecil di tabel besar — kehilangan recall tanpa error apa pun.
    const nilai = await withTenant(db, idA, async (tx) => {
      const r = await tx.execute(sql`SHOW hnsw.iterative_scan`)
      return rowsOf(r)[0]!["hnsw.iterative_scan"] as string
    })
    expect(nilai).toBe("strict_order")
  })

  it("tenant tidak bisa MENULIS baris milik tenant lain", async () => {
    // Jalur tulis. Isolasi baca yang sempurna tidak ada gunanya kalau sebuah tenant
    // masih bisa menanam baris di data tenant lain — dan itu justru yang paling
    // merusak: klaim bisnis palsu di transkrip orang lain, atau biaya di buku besar
    // orang lain.
    const gagal: string[] = []
    const upaya: [string, ReturnType<typeof sql>][] = [
      ["usage_events", sql`
        INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, cost_cents)
        VALUES (${idB}, 'test', 1, 1, 500000)`],
      ["conversations", sql`
        INSERT INTO conversations (tenant_id, channel, visitor_id)
        VALUES (${idB}, 'widget', 'penyusup')`],
      ["knowledge_sources", sql`
        INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
        VALUES (${idB}, 'text', 'penyusup.txt', 'ready')`],
    ]
    for (const [nama, perintah] of upaya) {
      let ditolak = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(perintah)
        })
      } catch {
        ditolak = true
      }
      if (!ditolak) gagal.push(nama)
    }
    expect(gagal).toEqual([])
  })
})
