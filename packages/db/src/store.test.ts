import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { createStore } from "./store.js"
import {
  chunks, conversations, documents, knowledgeSources, tenants, tenantSettings,
} from "./schema.js"
import { withTenant } from "./tenant.js"

// Parameternya `offset`, bukan `seed` — nama `seed` sudah dipakai fungsi seeding
// di bawah, dan menaunginya membuat lint mengeluh serta pembaca ragu.
function fakeEmbedding(offset: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(offset + i) * 0.01)
}

/**
 * Menyiapkan satu tenant lengkap: settings, sumber, dokumen, dua chunk, dan satu
 * percakapan. `garansiText` dibuat berbeda antar tenant supaya test isolasi bisa
 * membuktikan tenant MANA yang datanya terlihat — bukan sekadar bahwa hasilnya kosong.
 */
async function seed(
  db: Awaited<ReturnType<typeof freshPglite>>,
  slug: string,
  garansiText: string,
) {
  const [t] = await db.insert(tenants).values({ slug, name: slug }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "a.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Kebijakan" }).returning()
  const rows = await db.insert(chunks).values([
    // Memuat kata kuncinya, embedding JAUH dari query uji.
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: garansiText,
      embedding: fakeEmbedding(50), embeddingModel: "test" },
    // TIDAK memuat kata kuncinya, embedding IDENTIK dengan query uji.
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: SEM_ONLY,
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    // Embedding identik TAPI model berbeda -> harus tersaring dari jalur vektor.
    { tenantId: t!.id, documentId: d!.id, ordinal: 2,
      content: MODEL_LAIN,
      embedding: fakeEmbedding(1), embeddingModel: "model-lain" },
  ]).returning()
  const [cv] = await db.insert(conversations)
    .values({ tenantId: t!.id, channel: "widget", visitorId: "v1" }).returning()
  return { tenantId: t!.id, chunkId: rows[0]!.id, conversationId: cv!.id }
}

const GARANSI_TOKO = "Garansi resmi berlaku 12 bulan sejak pembelian."
const GARANSI_WARUNG = "Garansi warung hanya 3 bulan."
const SEM_ONLY = "Pengiriman ke Jawa memakan waktu dua hari kerja."
const MODEL_LAIN = "Garansi lama: ini di-embed dengan model lain."
const TANPA_EMBEDDING = "Kebijakan pengembalian barang berlaku tujuh hari."

/**
 * ID chunk eksplisit, bukan bawaan `defaultRandom()`. Skenario di bawah butuh urutan
 * PERINGKAT yang deterministik antar baris yang SENGAJA dibuat ber-ts_rank sama (satu
 * kemunculan kata kunci) dan/atau ber-jarak kosinus sama — dan `ORDER BY ..., c.id`
 * di `store.ts` memakai id sebagai pemutus seri. Dengan id acak, siapa menang seri
 * berubah tiap jalan test, dan test yang bergantung padanya jadi flaky.
 */
function fixedId(kategori: string, n: number): string {
  return `00000000-0000-4000-8000-${kategori}${String(n).padStart(8, "0")}`
}

/**
 * Skenario "12 chunk tak relevan" dari kalkulasi di `store.ts`, dibuat NYATA lewat
 * fixture, bukan cuma di komentar. Tenant terpisah dari `toko`/`warung` supaya ~28
 * baris chunk-nya tidak mengubah apa yang dilihat test lain.
 *
 * - `TANPA_EMBEDDING`: satu kemunculan kata kunci, id terkecil -> peringkat kata
 *   kunci #1 terjamin (menang seri lewat id, bukan lewat relevansi teks — ts_rank
 *   TERBUKTI sama untuk satu kemunculan berapa pun panjang dokumennya).
 * - 12 chunk "hanya kata kunci": memuat kata kuncinya, TANPA embedding. Mengisi
 *   peringkat kata kunci #2-13. Satu-daftar selamanya, jadi TIDAK PERNAH mengalahkan
 *   `TANPA_EMBEDDING` di k mana pun — amannya independen dari k.
 * - 12 chunk "hanya vektor": embedding DEKAT ke vektor query, TIDAK memuat kata
 *   kuncinya. Mengisi peringkat vektor #1-12. Sama-sama satu-daftar, sama amannya.
 * - 3 "chunk tak relevan": SEPERTI `TANPA_EMBEDDING`, MEMUAT kata kuncinya (satu
 *   kemunculan, ts_rank sama) DAN punya embedding — jadi DUA-daftar, dengan
 *   peringkat kata-kunci #14-16 dan peringkat vektor #13-15 (di belakang ke-24
 *   chunk satu-daftar di atas). Itulah "Catatan operasional nomor 2 tentang
 *   pengiriman" yang disebut di alasan konstanta: relevansinya buruk di KEDUA
 *   jalur, tapi kehadiran ganda itu sendiri cukup mengalahkan `TANPA_EMBEDDING`
 *   pada k=60 (skor gabungan ~0,0268 vs 0,0164) dan TIDAK CUKUP pada k=10
 *   (~0,0851 vs 0,0909) — persis arah yang harus dibalik oleh perbaikan ini.
 */
async function seedRrfGap(db: Awaited<ReturnType<typeof freshPglite>>) {
  const [t] = await db.insert(tenants).values({ slug: "gudang", name: "gudang" }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "b.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Gudang" }).returning()

  const rows: (typeof chunks.$inferInsert)[] = [
    { id: fixedId("0000", 0), tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: TANPA_EMBEDDING, embedding: null, embeddingModel: "test" },
  ]
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: fixedId("1111", i), tenantId: t!.id, documentId: d!.id, ordinal: 10 + i,
      content: `Catatan pengembalian barang nomor ${i}, hanya kata kunci, tanpa embedding.`,
      embedding: null, embeddingModel: "test",
    })
  }
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: fixedId("2222", i), tenantId: t!.id, documentId: d!.id, ordinal: 40 + i,
      content: `Catatan pengiriman tidak terkait sama sekali nomor ${i}.`,
      embedding: fakeEmbedding(600 + i * 0.01), embeddingModel: "test",
    })
  }
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: fixedId("9999", i), tenantId: t!.id, documentId: d!.id, ordinal: 90 + i,
      content: `Catatan operasional nomor ${i} tentang pengiriman, sedikit menyinggung `
        + "pengembalian barang di sela-sela laporan.",
      embedding: fakeEmbedding(700 + i * 0.01), embeddingModel: "test",
    })
  }
  await db.insert(chunks).values(rows)
  return { tenantId: t!.id }
}

// SATU database dipakai bersama oleh seluruh test di file ini, lewat `beforeAll`.
// Dua alasan:
//   1. `freshPglite()` membangun Postgres WASM lengkap dan menerapkan migrasi —
//      sekitar 7 detik dan beberapa ratus MB per instance. EMPAT instance dalam
//      satu file membuat worker vitest mati dengan "Worker exited unexpectedly".
//      Itu terukur, bukan dugaan.
//   2. Test di bawah ini aman berbagi: tiga yang pertama hanya membaca, dan yang
//      terakhir hanya menulis ke `messages`, `message_citations`, dan
//      `escalations` — tabel yang tidak dibaca test lain. Kalau nanti ada test
//      yang membaca tabel tulis itu, urutan test mulai berpengaruh dan file ini
//      harus dipecah, bukan ditambahi.
describe("createStore", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let toko: Awaited<ReturnType<typeof seed>>
  let warung: Awaited<ReturnType<typeof seed>>
  let gudang: Awaited<ReturnType<typeof seedRrfGap>>

  beforeAll(async () => {
    db = await freshPglite()
    toko = await seed(db, "toko", GARANSI_TOKO)
    warung = await seed(db, "warung", GARANSI_WARUNG)
    gudang = await seedRrfGap(db)
  })

  it("mengembalikan konfigurasi tenant", async () => {
    const cfg = await createStore(db).getTenantConfig(toko.tenantId)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
    expect(cfg.highRiskTopics).toContain("garansi")
  })

  it("menemukan chunk lewat kata kunci", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 5,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toBe(GARANSI_TOKO)
    expect(hits[0]!.documentTitle).toBe("Kebijakan")
  })

  it("jalur kata kunci hidup: chunk ber-kata-kunci menang walau embedding-nya jauh", async () => {
    // Embedding query sengaja jauh dari SEMUA chunk, jadi satu-satunya alasan sebuah
    // chunk bisa menang adalah jalur kata kunci. Kalau suku ts_rank dihapus dari
    // implementasi, test ini gagal — yang tidak terjadi pada versi sebelumnya.
    //
    // Offset 600, bukan 999: `fakeEmbedding` berbasis sin(offset+i), jadi periodik.
    // Diverifikasi lewat perhitungan cosine manual bahwa 600 membuat jalur semantik
    // SENDIRIAN memenangkan SEM_ONLY (bukan GARANSI_TOKO) — sehingga tanpa jalur kata
    // kunci, test ini benar-benar gagal, bukan kebetulan tetap lolos.
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(GARANSI_TOKO)
  })

  it("jalur semantik hidup: tanpa kecocokan kata kunci, yang terdekat tetap ditemukan", async () => {
    // Query yang tidak cocok kata kunci apa pun. Kalau suku cosine dihapus, jalur
    // kata kunci tidak mengembalikan apa pun dan test ini gagal.
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "zzz tidak ada di mana pun",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(SEM_ONLY)
  })

  it("jalur vektor hanya mempertimbangkan model embedding yang diminta", async () => {
    // Filter `embedding_model` ada di CTE `sem` SAJA, dan itu memang benar: isi teks
    // sebuah chunk tidak bergantung pada model embedding-nya, jadi jalur kata kunci
    // sah mencakup semua chunk. Yang dijaga adalah ruang vektornya tidak tercampur.
    //
    // Fixture-nya sengaja MEMUAT kata kunci "garansi". Versi sebelumnya tidak, dan
    // karena itu test-nya lolos tanpa membuktikan apa pun tentang filter tersebut.
    const lewatKataKunci = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 10,
    })
    // Lewat jalur kata kunci ia MEMANG boleh muncul — isinya valid.
    expect(lewatKataKunci.map((h) => h.content)).toContain(MODEL_LAIN)

    // Tapi lewat jalur vektor ia TIDAK boleh: query tanpa kecocokan kata kunci apa pun,
    // dengan embedding identik dengan chunk itu, tetap tidak boleh mengembalikannya.
    const lewatVektor = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "zzz tidak ada di mana pun",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 10,
    })
    expect(lewatVektor.map((h) => h.content)).not.toContain(MODEL_LAIN)
  })

  it("chunk ber-kata-kunci tanpa embedding tetap bisa ditemukan di antara chunk tak relevan", async () => {
    // Kasus nyata: dokumen baru diunggah, embedding-nya belum selesai dibuat, lalu
    // pelanggan bertanya. Fixture-nya (lihat `seedRrfGap`) membangun skenario persis
    // seperti yang diukur di alasan konstanta RRF: `TANPA_EMBEDDING` bersaing dengan
    // 24 chunk satu-daftar (aman di k mana pun) DAN 3 chunk dua-daftar yang relevansi
    // teksnya buruk tapi kehadiran gandanya, pada k=60, tetap cukup mengalahkannya.
    //
    // Query "pengembalian barang" 2 kata SENGAJA, bukan "garansi": dengan fixture
    // 4-chunk lama, satu-satunya chunk yang cocok kata kunci untuk query ini SELALU
    // masuk `limit`, apa pun konstantanya — test itu lolos tanpa membuktikan apa pun.
    // Diverifikasi lewat `pnpm vitest` berulang bahwa hasil ini stabil, bukan
    // kebetulan menang seri id (lihat `fixedId`).
    const hits = await createStore(db).searchChunks({
      tenantId: gudang.tenantId, query: "pengembalian barang",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 3,
    })
    expect(hits.map((h) => h.content)).toContain(TANPA_EMBEDDING)
  })

  it("setiap tenant hanya melihat chunk miliknya sendiri", async () => {
    // DUA tenant sungguhan, masing-masing punya chunk yang bisa dibedakan.
    // Menanyai satu uuid acak yang tidak punya data hanya membuktikan "kosong", dan
    // itu tidak membedakan "RLS menyaring" dari "tenant ini memang tak punya apa-apa".
    // Di sini kedua tenant punya isi, jadi kalau RLS bocor, test ini gagal.
    const store = createStore(db)
    const args = { query: "garansi", embedding: fakeEmbedding(1), embeddingModel: "test", limit: 5 }

    const isiToko = (await store.searchChunks({ tenantId: toko.tenantId, ...args }))
      .map((h) => h.content)
    const isiWarung = (await store.searchChunks({ tenantId: warung.tenantId, ...args }))
      .map((h) => h.content)

    expect(isiToko).toContain(GARANSI_TOKO)
    expect(isiToko).not.toContain(GARANSI_WARUNG)
    expect(isiWarung).toContain(GARANSI_WARUNG)
    expect(isiWarung).not.toContain(GARANSI_TOKO)

    // Tenant yang sama sekali tidak ada tetap harus kosong.
    const isiAsing = await store.searchChunks({
      tenantId: "00000000-0000-0000-0000-000000000000", ...args,
    })
    expect(isiAsing).toEqual([])
  })

  it("menyimpan jawaban beserta sitasinya, dan menyimpan eskalasi", async () => {
    const store = createStore(db)
    await store.recordUserTurn({
      tenantId: toko.tenantId,
      conversationId: toko.conversationId,
      text: "garansi berapa lama?",
    })
    await store.recordAnswer({
      tenantId: toko.tenantId,
      conversationId: toko.conversationId,
      segments: [
        { kind: "general", text: "Halo!" },
        { kind: "business_claim", text: "Garansi 12 bulan.", citations: [toko.chunkId] },
      ],
      citedChunkIds: [toko.chunkId],
    })
    await store.recordEscalation({
      tenantId: toko.tenantId,
      conversationId: toko.conversationId,
      reason: "no_source",
    })

    const counts = await withTenant(db, toko.tenantId, async (tx) => {
      const res = await tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM messages)          AS messages,
          (SELECT count(*)::int FROM message_citations) AS citations,
          (SELECT count(*)::int FROM escalations)       AS escalations
      `)
      return (Array.isArray(res) ? res : (res as { rows: Record<string, unknown>[] }).rows)[0]!
    })

    expect(counts.messages).toBe(2)
    expect(counts.citations).toBe(1)
    expect(counts.escalations).toBe(1)
  })
})
