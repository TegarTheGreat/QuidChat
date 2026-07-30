# Rencana Pengerasan Fondasi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menutup enam cacat yang ditemukan review akhir Rencana 1, yang semuanya lolos seluruh test suite karena test-nya tidak memeriksa properti yang diklaimnya.

**Architecture:** Tidak ada modul baru. Rencana ini memperbaiki lima berkas yang sudah ada di `packages/core` dan `packages/db`, ditambah migrasi, dan menambah test yang **gagal kalau propertinya rusak** — yang tidak dilakukan test sekarang.

**Tech Stack:** Sama dengan Rencana 1. Tidak ada dependency baru.

## Mengapa rencana ini ada

Review akhir Rencana 1 menemukan cacatnya dengan **merusak kode lalu melihat test tetap hijau**. Empat properti yang rencana itu klaim sudah terpatok ternyata tidak:

| Yang dirusak | Test yang gagal |
|---|---|
| Tambah `CREATE POLICY leak ON tenant_settings USING (true)` — isolasi tenant hilang total | **nol** |
| Hapus suku `ts_rank` dari `ORDER BY` — pencarian kata kunci mati | **nol** |
| Hapus suku cosine dari `ORDER BY` — pencarian semantik mati | **nol** |
| Sisipkan `new Date().toISOString()` ke system prompt — cache batal setiap pesan | **nol** |

Suite hijau bukan bukti properti terjaga. Rencana ini membuatnya jadi bukti.

## Global Constraints

Sama dengan Rencana 1, dan tetap mengikat:

- Node `>=22.22.3`. TypeScript strict. ESM only; import sumber TypeScript memakai ekstensi `.js`.
- Postgres satu-satunya penyimpanan, satu set skema & migrasi untuk semua tier.
- **RLS adalah SATU-SATUNYA mekanisme isolasi tenant.** Kode aplikasi tidak boleh menambah `WHERE tenant_id = ...` pada pembacaan ber-scope.
- `packages/core` library murni: `dependencies` kosong, tanpa akses env, tanpa jaringan.
- Semua komentar dan copy untuk pengguna berbahasa Indonesia. Identifier bahasa Inggris.
- Commit tanpa trailer atribusi apa pun.
- Setiap task hanya mendeklarasikan apa yang ia buat.
- **`pnpm build` masuk verifikasi setiap task.**

## File Structure

- `packages/db/migrations/0001_init.sql` — guard RLS diperketat; `GRANT quidchat_app` ke role login.
- `packages/db/src/store.ts` — filter aplikasi dihapus; `searchChunks` jadi RRF.
- `packages/db/src/store.test.ts` — test yang memaku kedua paruh retrieval.
- `packages/db/src/client.ts` — komentar tier-3 yang salah dikoreksi.
- `packages/core/src/store.ts` — `searchChunks` dapat `embeddingModel`; `recordUserTurn` ditambah.
- `packages/core/src/pipeline.ts` — ronde perbaikan yang benar-benar berbeda; transkrip lengkap.
- `packages/core/src/prompt/builder.ts` — parameter umpan balik verdict.
- `packages/core/src/prompt/builder.test.ts` — test wajib #3 dengan jam yang bergerak.
- `packages/core/src/testing/fakes.ts` — `MemoryStore` mengikuti interface baru.

---

### Task 1: RLS jadi satu-satunya penjaga, dan guard yang membuktikannya

**Files:**
- Modify: `packages/db/src/store.ts` (hapus `WHERE tenant_id` di `getTenantConfig`)
- Modify: `packages/db/migrations/0001_init.sql` (guard diperketat)
- Modify: `packages/db/src/client.ts` (komentar yang salah)

**Interfaces:**
- Consumes: `withTenant` dari Rencana 1
- Produces: tidak ada API baru

Temuan yang ditutup: `getTenantConfig` membawa `WHERE tenant_id = $1` — satu-satunya filter aplikasi di paket, dan tepat yang dilarang Global Constraints. Dibuktikan review: menambah policy bocor ke `tenant_settings` membuat 7/7 test tetap hijau, karena filter aplikasinya mengembalikan baris yang benar walau isolasinya sudah runtuh.

- [ ] **Step 1: Hapus filter aplikasi**

Di `packages/db/src/store.ts`, di dalam `getTenantConfig`, ganti query-nya:

```ts
        const res = await tx.execute(sql`
          SELECT chat_model, rewrite_model, embedding_model, refusal_text, high_risk_topics
          FROM tenant_settings
        `)
```

Tanpa `WHERE`. Sudah diverifikasi di PGlite: di dalam `withTenant`, query ini mengembalikan **tepat satu** baris, milik tenant yang sedang aktif. Kalau policy-nya rusak, ia mengembalikan lebih dari satu dan test gagal — itulah gunanya.

Tambahkan komentar ini persis di atas query:

```ts
        // TANPA `WHERE tenant_id` — dan itu wajib. RLS yang men-scope. Filter aplikasi
        // di sini akan mengembalikan baris yang benar bahkan ketika policy-nya sudah
        // runtuh, sehingga kebocoran isolasi lolos seluruh test dan baru terlihat di
        // produksi. Terbukti: policy bocor + filter ini = 7/7 test tetap hijau.
```

- [ ] **Step 2: Perketat guard migrasi**

Guard yang ada hanya memeriksa *ada* policy, bukan bahwa policy itu men-scope. Sudah diverifikasi bahwa `pg_policies.qual` berisi teks ekspresinya — untuk skema sekarang: `"(tenant_id = current_tenant_id())"`.

Di `packages/db/migrations/0001_init.sql`, ganti seluruh blok guard di akhir berkas dengan:

```sql
-- Guard bagian 1: setiap tabel ber-`tenant_id` wajib RLS aktif DAN forced, dan wajib
-- punya setidaknya satu policy.
DO $guard1$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s)', t.nama, t.alasan), ', ') INTO bad
  FROM (
    SELECT c.relname AS nama,
           CASE
             WHEN NOT (c.relrowsecurity AND c.relforcerowsecurity)
               THEN 'RLS tidak aktif atau tidak forced'
             WHEN NOT EXISTS (
               SELECT 1 FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname
             ) THEN 'tanpa policy'
           END AS alasan
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public' AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
      )
  ) t
  WHERE t.alasan IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS tidak lengkap: %', bad;
  END IF;
END $guard1$;

-- Guard bagian 2: SETIAP policy permissive pada tabel ber-`tenant_id` wajib menyebut
-- current_tenant_id(). Memeriksa "ada satu policy yang men-scope" TIDAK CUKUP: Postgres
-- menggabungkan policy permissive dengan OR, jadi satu `USING (true)` yang ditambahkan di
-- samping policy yang benar meruntuhkan isolasi sementara policy yang benar tetap ada.
-- Diukur di PGlite: serangan itu mengubah 1 baris menjadi 2, dan versi guard yang hanya
-- memeriksa keberadaan TETAP LOLOS.
DO $guard2$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s', p.tablename, p.policyname), ', ') INTO bad
  FROM pg_policies p
  JOIN pg_class c ON c.relname = p.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE p.schemaname = 'public'
    AND p.permissive = 'PERMISSIVE'
    AND EXISTS (
      SELECT 1 FROM information_schema.columns col
      WHERE col.table_schema = 'public' AND col.table_name = p.tablename
        AND col.column_name = 'tenant_id'
    )
    AND (p.qual IS NULL OR p.qual NOT LIKE '%current_tenant_id()%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'policy permissive tanpa current_tenant_id(): %', bad;
  END IF;
END $guard2$;
```

Sudah diverifikasi: keduanya lolos pada skema sekarang, dan **menolak** serangan policy
bocor berdampingan. Versi yang hanya memeriksa keberadaan policy yang men-scope TIDAK
menolaknya — itu ditemukan dengan menjalankan serangannya, bukan dengan membacanya.

- [ ] **Step 2b: Buat `getTenantConfig` menolak pembacaan ambigu**

Menghapus `WHERE` itu benar, tapi meninggalkan celah: kalau policy bocor, query-nya
mengembalikan beberapa baris dan kode diam-diam mengambil yang pertama — yang bisa milik
tenant lain. Karena setelan default setiap tenant identik di instalasi baru, test yang
memeriksa `chatModel` tidak akan menyadarinya.

Di `packages/db/src/store.ts`, di dalam `getTenantConfig`:

```ts
        const rows = rowsOf(res)
        if (rows.length === 0) throw new Error(`tenant_settings tidak ditemukan: ${tenantId}`)
        // Lebih dari satu baris berarti RLS sedang TIDAK mengisolasi — di bawah policy yang
        // benar, `SELECT` tanpa `WHERE` di dalam withTenant() hanya bisa melihat satu baris.
        if (rows.length > 1) {
          throw new Error(
            `isolasi tenant gagal: tenant_settings mengembalikan ${rows.length} baris untuk satu tenant`,
          )
        }
        const row = rows[0]!
```

Ini **assertion invariant**, bukan filter aplikasi: ia tidak mempersempit query, ia menolak
melanjutkan ketika hasil query membuktikan RLS rusak.

- [ ] **Step 3: Buat `quidchat_app` benar-benar bisa dipakai di tier 3**

`CREATE ROLE quidchat_app NOLOGIN` tanpa password dan tanpa `GRANT quidchat_app TO <role login>` membuat koneksi tier-3 yang didokumentasikan **mustahil**: connect sebagai `quidchat_app` gagal (NOLOGIN), dan connect sebagai role lain gagal di `SET LOCAL ROLE` dengan "permission denied to set role".

Di `0001_init.sql`, tepat setelah blok `GRANT ... ON ALL TABLES ... TO quidchat_app`, tambahkan:

```sql
-- Role yang dipakai aplikasi untuk konek WAJIB jadi anggota `quidchat_app`, kalau tidak
-- `SET LOCAL ROLE quidchat_app` di withTenant() gagal dengan "permission denied to set
-- role". `quidchat_app` sendiri NOLOGIN dengan sengaja: ia bukan role untuk konek, ia
-- role untuk DITURUNI setelah konek. Baris ini memberi keanggotaan itu ke role yang
-- sedang menjalankan migrasi, yang di tier 1 dan 2 memang role aplikasinya.
DO $grant$
BEGIN
  EXECUTE format('GRANT quidchat_app TO %I', current_user);
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- sudah anggota
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'tidak bisa GRANT quidchat_app TO %; lakukan manual sebagai superuser', current_user;
END $grant$;
```

- [ ] **Step 4: Koreksi komentar tier-3 yang salah di `client.ts`**

Komentar sekarang menyatakan bahwa `url` superuser mereproduksi kebocoran PGlite. Itu **salah** untuk jalur `withTenant`, dan test yang ada membuktikan sebaliknya: PGlite konek sebagai superuser `postgres`, tapi di dalam `withTenant` query yang sama melihat 1 baris bukan 2, karena `SET LOCAL ROLE` menurunkan `current_user` sehingga RLS berlaku. Kebocorannya **hanya** di raw handle.

Ganti komentar itu dengan:

```ts
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
```

- [ ] **Step 5: Verifikasi**

```bash
pnpm test        # 34 test tetap hijau
pnpm typecheck
pnpm lint        # tetap 0 peringatan
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "fix(db): let RLS be the only tenant filter, and prove policies scope"
```

---

### Task 2: Hybrid search yang benar-benar hybrid (RRF)

**Files:**
- Modify: `packages/core/src/store.ts` (`searchChunks` dapat `embeddingModel`)
- Modify: `packages/db/src/store.ts` (RRF)
- Modify: `packages/core/src/pipeline.ts` (meneruskan `config.embeddingModel`)
- Modify: `packages/core/src/testing/fakes.ts` (`MemoryStore` mengikuti interface)
- Modify: `packages/db/src/store.test.ts` (test yang memaku kedua paruh)

**Interfaces:**
- Produces: `searchChunks(args: { tenantId: string; query: string; embedding: number[]; embeddingModel: string; limit: number }): Promise<Candidate[]>`

Dua temuan sekaligus. **Pertama**, skala kedua skor tidak sebanding: `ts_rank` untuk kecocokan satu kata = **0,0608**, sementara `1 - cosine` berkisar **[-1, 1]** — selebar 2,0. Diukur di PGlite: untuk query `"garansi"`, chunk yang **memuat** kata itu mendapat total 0,3615 dan **kalah** dari chunk yang sama sekali tidak memuatnya tapi embedding-nya identik (1,0). Peringkat kata kunci menyumbang ~3% skala; praktis mati. Itu meniadakan alasan hybrid retrieval ada: istilah persis, SKU, nama produk.

**Kedua**, `chunks.embedding_model` disimpan justru supaya retrieval bisa tetap memakai model lama selama re-index (spec §3.3), tapi tidak ada yang membacanya dan interface-nya tidak memberi pemanggil cara menyebut model. Akibatnya saat tenant berganti model embedding berdimensi sama, `chunks` menampung dua ruang vektor, peringkatnya kacau, dan asisten menyitasi chunk yang salah tapi terlihat masuk akal — persis kegagalan yang spec §3.3 gambarkan: *"retrieval tidak error — ia mengembalikan hasil yang tidak relevan tapi terlihat masuk akal."*

- [ ] **Step 1: Tambahkan `embeddingModel` ke interface `Store`**

Di `packages/core/src/store.ts`:

```ts
  /** Hybrid search: RRF atas top-k jalur kata kunci dan jalur vektor. Dibatasi tenant oleh RLS. */
  searchChunks(args: {
    tenantId: string
    query: string
    embedding: number[]
    /**
     * Model yang dipakai membuat `embedding`. Chunk yang di-embed dengan model LAIN
     * dikecualikan: dua ruang vektor berbeda dalam satu pencarian tidak error, ia hanya
     * mengembalikan hasil yang tidak relevan tapi terlihat masuk akal. Kolomnya ada di
     * `chunks.embedding_model` justru untuk ini (spec §3.3).
     */
    embeddingModel: string
    limit: number
  }): Promise<Candidate[]>
```

- [ ] **Step 2: Tulis test yang gagal — memaku KEDUA paruh**

Di `packages/db/src/store.test.ts`, ubah `seed` agar menerima chunk yang bisa dibedakan per jalur, lalu tambahkan test berikut. Konstanta baru di kepala berkas:

```ts
const KW_ONLY = "Garansi produk ini berlaku dua belas bulan."
const SEM_ONLY = "Pengiriman ke Jawa memakan waktu dua hari kerja."
const MODEL_LAIN = "Ini di-embed dengan model lain dan tidak boleh muncul."
```

Di dalam `seed`, ganti kedua chunk menjadi tiga:

```ts
  const rows = await db.insert(chunks).values([
    // Memuat kata kuncinya, embedding JAUH dari query uji.
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: garansiText,
      embedding: fakeEmbedding(50), embeddingModel: "test" },
    // TIDAK memuat kata kuncinya, embedding IDENTIK dengan query uji.
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: SEM_ONLY,
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    // Embedding identik TAPI model berbeda -> harus tersaring.
    { tenantId: t!.id, documentId: d!.id, ordinal: 2,
      content: MODEL_LAIN,
      embedding: fakeEmbedding(1), embeddingModel: "model-lain" },
  ]).returning()
```

Dan tambahkan tiga test ini:

```ts
  it("jalur kata kunci hidup: chunk ber-kata-kunci menang walau embedding-nya jauh", async () => {
    // Embedding query WAJIB jauh dari SEMUA chunk, supaya satu-satunya alasan sebuah
    // chunk bisa menang adalah jalur kata kunci. Kalau suku ts_rank dihapus dari
    // implementasi, test ini gagal — yang tidak terjadi pada versi sebelumnya.
    //
    // Offset 600 BUKAN sembarang angka. `fakeEmbedding` memakai `Math.sin(offset + i)`,
    // yang PERIODIK, jadi offset yang terlihat "jauh" bisa justru berdekatan. Jarak
    // cosine yang terukur:
    //     offset 999 -> 0,0284 dari chunk kata-kunci   (praktis IDENTIK)
    //     offset 600 -> 1,9756 dari chunk kata-kunci, 1,5027 dari chunk semantik
    // Versi pertama test ini memakai 999 dan karena itu LOLOS walau jalur kata kunci
    // dihapus: chunk-nya menang lewat jalur semantik. Test yang tidak bisa gagal.
    // Kalau offset ini diubah, HITUNG ULANG jarak cosine-nya lebih dulu.
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

  it("chunk dari model embedding lain dikecualikan", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 10,
    })
    expect(hits.map((h) => h.content)).not.toContain(MODEL_LAIN)
  })
```

Sesuaikan juga test `"menemukan chunk lewat kata kunci"` yang sudah ada agar meneruskan `embeddingModel: "test"`.

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

Run: `pnpm vitest run packages/db/src/store.test.ts`
Expected: FAIL — argumen `embeddingModel` belum diterima.

- [ ] **Step 4: Ganti `searchChunks` dengan RRF**

Di `packages/db/src/store.ts`:

```ts
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
```

Konstanta 60 adalah nilai dari makalah RRF asli. `c.id` sebagai tie-breaker di setiap `ORDER BY` membuat hasilnya deterministik; tanpa itu chunk berskor sama bisa bertukar urutan antar pemanggilan.

Tetap **tidak ada** `WHERE c.tenant_id` di kedua CTE — RLS yang men-scope.

- [ ] **Step 5: Teruskan `embeddingModel` dari pipeline**

Di `packages/core/src/pipeline.ts`:

```ts
  const candidates = await store.searchChunks({
    tenantId, query: question, embedding,
    embeddingModel: config.embeddingModel,
    limit: CANDIDATE_LIMIT,
  })
```

Model yang dipakai meng-embed pertanyaan dan model yang menyaring chunk kini pasti sama, karena keduanya `config.embeddingModel`.

- [ ] **Step 6: Sesuaikan `MemoryStore`**

`MemoryStore.searchChunks` mengabaikan argumennya, jadi tidak ada perubahan tanda tangan yang diperlukan — tapi jalankan `pnpm typecheck` untuk memastikan.

- [ ] **Step 7: Verifikasi**

```bash
pnpm test        # 43 test (store 4 -> 7)
pnpm typecheck
pnpm lint
pnpm build
```

- [ ] **Step 8: Commit**

```bash
git add packages/core packages/db
git commit -m "fix(db): fuse hybrid search by rank so keyword retrieval actually counts"
```

---

### Task 3: Test wajib #3 memakai jam yang bergerak

**Files:**
- Modify: `packages/core/src/prompt/builder.test.ts`

Spec §11.1 menyebut alasan test ini ada dengan sangat spesifik: *"satu `new Date()` di system prompt membatalkan cache setiap pertanyaan, tanpa error dan tanpa log."* Review membuktikan test yang ada **tidak** menangkapnya: menyisipkan `new Date().toISOString()` ke system prompt membuat keenam test tetap hijau, karena dua pemanggilan `buildPrompt` jatuh di milidetik yang sama.

- [ ] **Step 1: Tambahkan test dengan jam palsu**

Di `packages/core/src/prompt/builder.test.ts`, tambahkan `vi` ke import vitest, lalu tambahkan test ini:

```ts
  it("prefix tetap identik walau waktu berjalan di antara dua pemanggilan", () => {
    // Inilah regresi yang spec §11.1 sebut sebagai alasan test ini ada: satu `new Date()`
    // di system prompt membatalkan cache setiap pesan, tanpa error dan tanpa log.
    // Test tanpa jam palsu TIDAK menangkapnya — dua pemanggilan jatuh di milidetik yang
    // sama, jadi stempel waktunya kebetulan sama dan prefix-nya tetap cocok.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const a = buildPrompt({ config, history, candidates: [c("k1", "isi")], question: "q1" })
      vi.advanceTimersByTime(60 * 60 * 1000) // satu jam
      const b = buildPrompt({ config, history, candidates: [c("k2", "lain")], question: "q2" })
      expect(prefixOf(a)).toBe(prefixOf(b))
    } finally {
      vi.useRealTimers()
    }
  })
```

- [ ] **Step 2: Buktikan test ini benar-benar menangkap regresinya**

Sisipkan sementara baris ini ke array `system` di `packages/core/src/prompt/builder.ts`:

```ts
    `Waktu sekarang: ${new Date().toISOString()}`,
```

Run: `pnpm vitest run packages/core/src/prompt/builder.test.ts`
Expected: **test baru GAGAL**, test lain lolos. Kalau test baru lolos, ia belum mengukur apa pun — laporkan, jangan lanjut.

Lalu **hapus baris itu lagi** dan jalankan ulang; semuanya harus hijau.

- [ ] **Step 3: Verifikasi**

```bash
pnpm test        # 38 test (builder 6 -> 7)
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/prompt
git commit -m "test(core): advance the clock so the cache test catches its own regression"
```

---

### Task 4: Ronde kedua yang benar-benar berbeda

**Files:**
- Modify: `packages/core/src/prompt/builder.ts` (parameter umpan balik)
- Modify: `packages/core/src/pipeline.ts` (meneruskan verdict)
- Modify: `packages/core/src/pipeline.test.ts` (test yang membuktikan prompt-nya beda)

Spec §4 langkah 6 meminta **ronde perbaikan**. Yang ada sekarang adalah resample byte-identik: semua input `buildPrompt` loop-invariant, jadi ronde 2 mengirim `PromptParts` yang sama persis. Dengan provider bertemperature 0 — default yang wajar untuk output terstruktur — ronde 2 mengembalikan jawaban ungrounded yang sama, jadi setiap turn ungrounded membayar dua kali untuk duplikat yang terjamin.

Ronde perbaikan versi rewrite-query membutuhkan method penyelesaian teks di `Provider`, yang belum ada dan menjadi wilayah rencana lapisan provider. Yang **bisa** dilakukan sekarang tanpa mengubah `Provider`: mengembalikan alasan penolakan validator ke model sebagai umpan balik. Itu membuat ronde 2 berbeda, memberi model informasi yang bisa ditindaklanjuti, dan memakai `complete` yang sudah ada.

- [ ] **Step 1: Terima umpan balik di `buildPrompt`**

Di `packages/core/src/prompt/builder.ts`, tambahkan field opsional ke argumennya dan pakai di `currentTurn`:

```ts
export function buildPrompt(args: {
  config: TenantConfig
  history: { role: "user" | "assistant"; content: string }[]
  candidates: Candidate[]
  question: string
  /**
   * Alasan jawaban sebelumnya ditolak, kalau ini ronde perbaikan. Ditaruh di
   * `currentTurn`, BUKAN di `system` — ia berubah per percobaan, dan menaruhnya di
   * bagian stabil akan membatalkan cache prefix untuk setiap pesan.
   */
  feedback?: string
}): PromptParts {
  const { config, history, candidates, question, feedback } = args
```

Lalu di penyusunan `currentTurn`:

```ts
  const currentTurn = [
    "<konteks>",
    contextBlock,
    "</konteks>",
    "",
    ...(feedback
      ? [
          "<perbaikan>",
          `Jawaban sebelumnya DITOLAK: ${feedback}`,
          "Perbaiki dengan menyitasi id dari <konteks> di atas untuk setiap klaim bisnis,",
          "atau sampaikan teks penolakan bila konteksnya memang tidak memuat jawabannya.",
          "</perbaikan>",
          "",
        ]
      : []),
    `Pertanyaan pelanggan: ${question}`,
  ].join("\n")
```

`prefixOf` tidak berubah: umpan baliknya hanya menyentuh `currentTurn`, jadi kestabilan prefix tetap utuh — dan test wajib #3 tetap menjaganya.

- [ ] **Step 2: Teruskan verdict di pipeline**

Di `packages/core/src/pipeline.ts`, ganti isi loop-nya:

```ts
  let feedback: string | undefined
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prompt = buildPrompt({ config, history, candidates, question, feedback })

    let result
    try {
      result = await provider.complete({ model: config.chatModel, prompt })
    } catch {
      return refuse("schema_invalid")
    }

    const verdict = validateGrounding({
      answer: result.answer,
      candidates,
      highRiskTopics: config.highRiskTopics,
    })

    if (verdict.ok) {
      // ... tidak berubah ...
    }

    // Alasan penolakan dibawa ke ronde berikutnya. Tanpa ini ronde 2 mengirim prompt
    // yang IDENTIK, dan model bertemperature 0 mengembalikan jawaban yang identik —
    // biaya dua kali untuk duplikat yang terjamin.
    feedback = `${verdict.violation} — ${verdict.detail}`
  }
```

- [ ] **Step 3: Test bahwa prompt ronde kedua BERBEDA**

Di `packages/core/src/pipeline.test.ts`, tambahkan ke test `"mencoba ronde kedua saat validasi gagal, lalu berhasil"`:

```ts
    expect(provider.calls).toHaveLength(2)
    // Ronde kedua wajib membawa prompt yang BERBEDA. Assertion inilah yang gagal pada
    // versi sebelumnya, ketika ronde 2 adalah resample byte-identik.
    expect(provider.calls[1]!.currentTurn).not.toBe(provider.calls[0]!.currentTurn)
    expect(provider.calls[1]!.currentTurn).toContain("missing_citation")
    // Tapi PREFIX-nya wajib tetap sama, kalau tidak cache-nya batal.
    expect(provider.calls[1]!.system).toBe(provider.calls[0]!.system)
    expect(res.kind).toBe("answered")
```

- [ ] **Step 4: Verifikasi**

```bash
pnpm test        # 38 test, jumlah sama (assertion ditambah, bukan test)
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "fix(core): feed the rejection reason into the repair round"
```

---

### Task 5: Transkrip yang lengkap

**Files:**
- Modify: `packages/core/src/store.ts` (`recordUserTurn`)
- Modify: `packages/db/src/store.ts` (implementasinya)
- Modify: `packages/core/src/pipeline.ts` (catat turn user + balasan termasuk penolakan)
- Modify: `packages/core/src/testing/fakes.ts` (`MemoryStore`)
- Modify: `packages/core/src/pipeline.test.ts`, `packages/db/src/store.test.ts`

Penolakan tidak meninggalkan pesan assistant di transkrip, dan tidak ada cara mencatat turn user sama sekali. Akibatnya `messages` hanya berisi jawaban yang berhasil: tenant yang membuka percakapan untuk melihat **mengapa** bot eskalasi — tujuan yang dinyatakan catatan eskalasi — melihat pertanyaan tanpa jawaban, begitu juga widget yang memutar ulang riwayat.

- [ ] **Step 1: Tambahkan `recordUserTurn` ke interface**

Di `packages/core/src/store.ts`:

```ts
  /** Mencatat pesan pengunjung. Dipanggil sebelum retrieval supaya transkrip utuh
   *  bahkan ketika turn-nya berakhir dengan penolakan. */
  recordUserTurn(args: {
    tenantId: string
    conversationId: string
    text: string
  }): Promise<void>
```

- [ ] **Step 2: Implementasikan di `packages/db/src/store.ts`**

```ts
    async recordUserTurn({ tenantId, conversationId, text }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO messages (tenant_id, conversation_id, role, content)
          VALUES (${tenantId}, ${conversationId}, 'user', ${text})
        `)
      })
    },
```

- [ ] **Step 3: Buat `refuse` menulis balasannya juga**

Di `packages/core/src/pipeline.ts`, catat turn user lebih dulu, dan buat `refuse` menyimpan teks penolakannya sebagai pesan assistant:

```ts
  const { store, provider, tenantId, conversationId, history, question } = args
  const config = await store.getTenantConfig(tenantId)

  await store.recordUserTurn({ tenantId, conversationId, text: question })

  const refuse = async (reason: EscalationReason): Promise<PipelineResult> => {
    await store.recordEscalation({ tenantId, conversationId, reason })
    // Teks penolakan ikut masuk transkrip. Tanpa ini, tenant yang membuka percakapan
    // untuk mencari tahu mengapa bot eskalasi hanya melihat pertanyaan tanpa balasan,
    // dan widget yang memutar ulang riwayat kehilangan separuh percakapan.
    await store.recordAnswer({
      tenantId, conversationId,
      segments: [{ kind: "general", text: config.refusalText }],
      citedChunkIds: [],
    })
    return { kind: "refused", text: config.refusalText, reason }
  }
```

- [ ] **Step 4: Sesuaikan `MemoryStore`**

Di `packages/core/src/testing/fakes.ts`, tambahkan:

```ts
  recordedUserTurns: string[] = []

  async recordUserTurn(args: { text: string }): Promise<void> {
    this.recordedUserTurns.push(args.text)
  }
```

- [ ] **Step 5: Sesuaikan test yang terpengaruh, lalu tambahkan yang baru**

Test `"KB kosong menghasilkan penolakan"` sekarang juga akan mencatat satu jawaban, jadi tambahkan:

```ts
    expect(store.recordedUserTurns).toEqual(["garansi berapa lama?"])
    // Penolakan pun meninggalkan balasan di transkrip.
    expect(store.recordedAnswers).toHaveLength(1)
    expect(store.recordedAnswers[0]!.citedChunkIds).toEqual([])
```

Di `packages/db/src/store.test.ts`, test keempat sekarang harus menghitung 1 pesan user + 1 pesan assistant. Sesuaikan `expect(counts.messages)` menjadi `2` setelah memanggil `recordUserTurn` sekali di test itu.

- [ ] **Step 6: Verifikasi**

```bash
pnpm test
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/db
git commit -m "feat(core): keep refusals in the conversation transcript"
```

---

### Task 6: Koreksi dokumen dan penugasan sisa

**Files:**
- Modify: `docs/superpowers/plans/2026-07-29-fondasi-dan-pipeline-inti.md`
- Modify: `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

- [ ] **Step 1: Koreksi klaim "tiga tier" di Rencana 1**

Baris arsitektur Rencana 1 menyebut tiga tier; `createDb` mendukung dua (`pglite` dan `postgres`). Ubah menjadi dua, dan catat bahwa tier `embedded` adalah urusan siklus-hidup proses yang masuk rencana `quidchat serve`, memakai ulang `kind: "postgres"` setelah prosesnya hidup.

- [ ] **Step 2: Tambahkan blok penugasan sisa ke spec**

Tambahkan ke spec, di bawah §11.4:

```markdown
### 11.5 Utang yang diakui, dengan pemiliknya

| Utang | Pemilik | Mengapa belum sekarang |
|---|---|---|
| Typed error di `Provider` supaya 429/503/timeout tidak tercatat sebagai `schema_invalid` | Rencana lapisan provider | Butuh perubahan interface `Provider`; sekarang setiap throw `complete()` jadi `schema_invalid` dan mencemari sinyal bisnis |
| Ronde perbaikan versi rewrite-query memakai `rewriteModel` | Rencana lapisan provider | Butuh method penyelesaian teks; sementara ini umpan balik verdict yang dipakai |
| Job CI terhadap Postgres sungguhan (tier 3) | Rencana server | Sandbox memblokir `spawn initdb`; `rowsOf` dan cabang `client.unsafe` belum pernah dieksekusi di tier yang paling penting |
| Tier `embedded-postgres` | Rencana `quidchat serve` | Urusan siklus-hidup proses; memakai ulang `kind: "postgres"` |
| Query CI: `messages` LEFT JOIN `message_citations` untuk menemukan jawaban tanpa sitasi | Rencana ingestion/eval | Jalur terakhir menuju kegagalan yang produk ini definisikan sebagai lawannya: jawaban ber-segmen `general` saja yang katanya luput dari daftar `high_risk_topics` |
| Onboarding tenant baru WAJIB memakai raw handle | Rencana admin/signup | Policy `tenant_self` ber-`USING` saja juga berlaku sebagai `WITH CHECK`, jadi `INSERT` tenant baru sebagai `quidchat_app` selalu gagal: `id` yang baru dibuat tidak mungkin sama dengan `current_tenant_id()` |
| `answer()` membuka 3–4 transaksi terpisah per turn | Rencana akuntansi biaya | Retrieval dan pencatatan tidak atomik satu sama lain; belum ada yang rusak, tapi perlu diketahui sebelum akuntansi budget mendarat |
```

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: correct the tier count and record acknowledged debt with owners"
```

---

## Definition of Done

- Enam temuan review akhir ditutup atau ditugaskan dengan eksplisit.
- Empat properti yang tadinya tidak terpatok kini gagal kalau dirusak — dan Task 3 Step 2 mewajibkan pembuktiannya, bukan hanya mengklaimnya.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 peringatan), `pnpm build` semuanya hijau.
- Filter aplikasi `WHERE tenant_id` nol di seluruh `packages/db`.
