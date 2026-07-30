# Rencana Pengerasan Ronde 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menutup dua serangan isolasi tenant yang masih berhasil, satu cacat parameter RRF yang membuat jalur kata kunci subordinat, dan empat klaim yang belum dipatok test.

**Architecture:** Tidak ada modul baru. Memperbaiki migrasi, `store.ts`, `tenant.ts`, dan memperluas test isolasi agar mencakup **tulis**, bukan hanya baca.

## Mengapa rencana ini ada

Ronde pertama pengerasan menutup empat properti yang tidak terpatok. Review akhirnya menemukan **dua serangan yang masih berhasil**, keduanya satu baris edit migrasi, keduanya meninggalkan 44/44 test hijau:

| Serangan | Akibat terukur | Test yang gagal |
|---|---|---|
| `WITH CHECK (true)` pada policy mana pun | Tulis lintas tenant BERHASIL: baris `usage_events` 500.000 sen di buku besar tenant lain, dan pesan assistant palsu "Harga promo Rp1, hubungi wa.me/62800" ditanam di transkrip bisnis lain | **nol** |
| `CREATE POLICY tenant_self ON tenants USING (true)` | `SELECT slug FROM tenants` mengembalikan SELURUH daftar pelanggan | **nol** |

**Akar penyebabnya satu, dan itu kesalahan desain.** Ketiga lapis pertahanan ronde pertama — guard1, guard2, dan test perilaku — semuanya memilih tabel lewat predikat yang **sama**: `information_schema.columns ... column_name = 'tenant_id'`. Pertahanan berlapis tidak ada artinya kalau setiap lapis bertumpu pada asumsi yang sama. `tenants` berkunci `id`, jadi ia luput dari ketiganya sekaligus. Dan tak satu pun dari ketiganya memeriksa jalur **tulis**.

## Global Constraints

Sama dengan rencana sebelumnya, dan tetap mengikat:

- Node `>=22.22.3`. TypeScript strict; `exactOptionalPropertyTypes: true`, jadi meneruskan `undefined` ke properti opsional gagal typecheck — pakai spread bersyarat.
- ESM only; import sumber TypeScript memakai ekstensi `.js`.
- **RLS satu-satunya mekanisme isolasi tenant.** Tidak ada `WHERE tenant_id = ...` pada pembacaan ber-scope.
- `packages/core` library murni: `dependencies` kosong, tanpa env, tanpa jaringan.
- Setiap `execute()` lewat `rowsOf()`.
- Komentar dan copy pengguna berbahasa Indonesia; identifier bahasa Inggris.
- Commit tanpa trailer atribusi apa pun. `git add` dengan path eksplisit, **jangan** `git add -A`.
- `pnpm build` masuk verifikasi setiap task.

## Fakta terukur yang mendasari rencana ini

Sudah diverifikasi di PGlite sebelum rencana ditulis:

- `pg_policies.with_check` **terisi** untuk 11 tabel ber-`tenant_id`: `"(tenant_id = current_tenant_id())"`. Untuk `tenants` ia `null` — Postgres menurunkannya dari `qual`. Jadi guard bisa dan **wajib** memeriksanya, sekaligus harus menerima `NULL` sebagai sah.
- Dari 12 tabel, **`tenants` satu-satunya** yang ber-RLS tanpa kolom `tenant_id`. Policy-nya `(id = current_tenant_id())`.
- Serangan `WITH CHECK (true)` pada `usage_events`: skema asli **menolak** tulis lintas tenant; setelah serangan, **berhasil**. `pg_policies.with_check` berubah menjadi `"true"` — terdeteksi.
- Serangan policy `tenants`: sebelum `["a"]`, sesudah `["a","b"]`.
- Aritmetika RRF, kolam 32: skor maksimum satu-daftar `1/(k+1)`, minimum dua-daftar `2/(k+32)`. Agar chunk peringkat-1 satu-daftar bisa menang, perlu `k < pool − 2`. Karena `poolSize = max(limit×4, 20)`, kolam **minimum 20**, jadi syaratnya `k < 18`. k=60 gagal (0,01639 < 0,02174); k=20 gagal untuk kolam kecil; **k=10 memenuhi seluruh rentang** (0,09091 > 0,04762) dan tetap mempertahankan sifat bahwa hadir di kedua daftar lebih baik (0,18182 > 0,09091).

---

### Task 1: Guard yang menutup tulis dan `tenants`

**Files:**
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`

Menutup Critical 1, Critical 2, dan Important 3.

- [ ] **Step 1: Ganti kedua blok guard dengan satu guard yang mengenumerasi lewat RLS**

Kunci perbaikannya: **enumerasi tabel lewat `relrowsecurity`, bukan lewat keberadaan kolom `tenant_id`.** Ekspresi yang diharapkan diturunkan dari kunci tabelnya — `tenant_id` kalau kolomnya ada, `id` kalau tidak — sehingga `tenants` ikut terjaga tanpa dikecualikan.

Di `packages/db/migrations/0001_init.sql`, ganti seluruh `DO $guard1$ ... END $guard1$;` dan `DO $guard2$ ... END $guard2$;` dengan:

```sql
-- Guard isolasi tenant. SATU blok, mengenumerasi lewat RLS.
--
-- Versi sebelumnya memilih tabel lewat `column_name = 'tenant_id'`, dan ITU
-- kesalahannya: `tenants` berkunci `id`, jadi ia luput dari SETIAP lapis pertahanan
-- sekaligus. Membocorkan policy-nya membuat `SELECT slug FROM tenants` mengembalikan
-- seluruh daftar pelanggan, dan tak satu pun test gagal.
--
-- Versi sebelumnya juga hanya memeriksa `qual`, yaitu jalur BACA. `WITH CHECK (true)`
-- membuka jalur TULIS sepenuhnya: terukur di PGlite, sebuah baris usage_events bernilai
-- 500.000 sen bisa ditulis ke buku besar tenant lain, dan pesan assistant palsu bisa
-- ditanam di transkrip bisnis lain. Guard-nya diam, 44 test tetap hijau.
--
-- `with_check IS NULL` sah dan berarti Postgres menurunkannya dari `qual` — itu yang
-- terjadi pada `tenants`. Yang ditolak adalah `with_check` yang ADA tapi berbeda.
DO $guard_isolasi$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s: %s', t.nama, t.alasan), ' | ') INTO bad
  FROM (
    SELECT c.relname AS nama,
           -- Kunci tenant tabel ini: `tenant_id` bila ada, kalau tidak `id`.
           -- `tenants` memakai `id` karena ia SENDIRI adalah tenant-nya.
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public' AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
           ) THEN 'tenant_id' ELSE 'id' END AS kunci,
           c.relrowsecurity AS rls_aktif,
           c.relforcerowsecurity AS rls_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) t
  CROSS JOIN LATERAL (
    SELECT format('(%s = current_tenant_id())', t.kunci) AS harapan
  ) h
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN NOT (t.rls_aktif AND t.rls_forced) THEN 'RLS tidak aktif atau tidak forced'
        WHEN NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.nama
        ) THEN 'tanpa policy'
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.nama
            AND p.permissive = 'PERMISSIVE'
            AND coalesce(p.qual, '') <> h.harapan
        ) THEN format('ada policy permissive dengan qual bukan %s', h.harapan)
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.nama
            AND p.permissive = 'PERMISSIVE'
            AND p.with_check IS NOT NULL
            AND p.with_check <> h.harapan
        ) THEN format('ada policy permissive dengan with_check bukan %s', h.harapan)
      END AS alasan
  ) a
  WHERE a.alasan IS NOT NULL;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'isolasi tenant tidak lengkap -> %', bad;
  END IF;
END $guard_isolasi$;
```

- [ ] **Step 2: Jalankan migrasi untuk memastikan guard lolos pada skema sehat**

Run: `pnpm vitest run packages/db/src/tenant.test.ts`
Expected: PASS. Kalau guard-nya menolak skema sendiri, ada kesalahan di ekspresi harapannya — laporkan angkanya, jangan lemahkan guard-nya.

- [ ] **Step 3: Test serangan untuk KETIGA lubang, plus mematok guard itu sendiri**

Di `packages/db/src/isolation-guard.test.ts`, ubah `blokGuard` agar memakai nama blok baru, lalu tambahkan test berikut ke `describe("isolasi tenant di bawah serangan")`:

```ts
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
```

- [ ] **Step 4: Test perilaku untuk jalur TULIS, dan sertakan `tenants` di jalur baca**

Di `describe("isolasi setiap tabel, diukur dari perilakunya")`, ubah enumerasinya dari "tabel ber-kolom `tenant_id`" menjadi "tabel ber-RLS", dan tambahkan test tulis:

```ts
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
```

`idB` perlu disimpan di `beforeAll` blok itu, sejajar `idA`.

- [ ] **Step 5: Verifikasi**

```bash
pnpm test        # 44 + 6 test baru = 50
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 6: Buktikan setiap test serangan benar-benar bisa gagal**

Untuk masing-masing dari tiga serangan, hapus sementara bagian guard yang menangkapnya dan pastikan test yang bersangkutan **gagal**. Laporkan yang teramati. Jangan lewati langkah ini: dua ronde review menemukan cacat justru dengan cara ini, dan tidak dengan cara lain.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0001_init.sql packages/db/src/isolation-guard.test.ts
git commit -m "fix(db): guard writes and the tenants table, not just tenant_id reads"
```

---

### Task 2: RRF yang tidak menyingkirkan jalur kata kunci

**Files:**
- Modify: `packages/db/src/store.ts`
- Modify: `packages/db/src/store.test.ts`

Menutup Important 4 dan Important 5.

- [ ] **Step 1: Turunkan konstanta RRF dari 60 ke 10, dengan alasannya**

Di `packages/db/src/store.ts`, ganti `60` di CTE `fused` menjadi `10`, dan ganti komentar di atasnya:

```ts
          fused AS (
            -- Konstanta RRF = 10, BUKAN 60 dari makalah aslinya. Alasannya aritmetika,
            -- bukan selera.
            --
            -- Skor maksimum chunk yang hanya muncul di SATU daftar adalah 1/(k+1).
            -- Skor minimum chunk yang muncul di KEDUA daftar adalah 2/(k+pool).
            -- Dengan k=60 dan pool=32: 0,01639 < 0,02174 — jadi chunk yang hadir di
            -- kedua daftar mengalahkan SETIAP chunk satu-daftar, sebaik apa pun
            -- kecocokannya.
            --
            -- Itu bukan sekadar tidak optimal, itu penyingkiran struktural: chunk
            -- ber-`embedding IS NULL` dan chunk yang masih memakai model embedding lama
            -- TIDAK BISA masuk daftar `sem`, jadi mereka selamanya satu-daftar. Terukur:
            -- satu chunk penjawab tanpa embedding di antara 12 chunk tak relevan
            -- ber-embedding jatuh ke peringkat 4; dengan >=8 chunk dua-daftar ia keluar
            -- dari jendela kandidat dan pipeline MENOLAK padahal jawabannya ada.
            --
            -- Syaratnya k < pool − 2. Karena `poolSize = max(limit*4, 20)`, kolam bisa
            -- sekecil 20, jadi k harus < 18. k=10 memenuhi seluruh rentang (0,09091 >
            -- 0,04762) dan TETAP membuat kehadiran di kedua daftar menguntungkan
            -- (0,18182 > 0,09091) — hanya tidak lagi mutlak.
            SELECT id, SUM(1.0 / (10 + rnk)) AS score
            FROM (SELECT id, rnk FROM kw UNION ALL SELECT id, rnk FROM sem) u
            GROUP BY id
          )
```

- [ ] **Step 2: Perbaiki nama dan komentar test `embedding_model` yang menyesatkan**

Filter `embedding_model` ada di CTE `sem` saja, dan **itu benar**: isi teks sebuah chunk tidak bergantung pada model embedding-nya, jadi jalur kata kunci memang sah mencakup semua chunk. Yang salah adalah nama test-nya, yang menjanjikan pengecualian menyeluruh.

Test lama lolos hanya karena teks fixture `MODEL_LAIN` kebetulan tidak memuat kata kuncinya. Ganti fixture-nya agar memuat, lalu ganti nama dan assertion test-nya:

```ts
const MODEL_LAIN = "Garansi lama: ini di-embed dengan model lain."
```

```ts
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
```

- [ ] **Step 3: Test bahwa chunk ber-kata-kunci TANPA embedding tetap bisa ditemukan**

Ini kasus yang sebelumnya tidak ditutup test mana pun, dan justru kasus yang paling merugikan pengguna: dokumen baru diunggah, embedding-nya belum jadi, pelanggan bertanya, bot menjawab "belum ada informasi itu".

Tambahkan chunk tanpa embedding di `seed`:

```ts
    { tenantId: t!.id, documentId: d!.id, ordinal: 3,
      content: TANPA_EMBEDDING, embedding: null, embeddingModel: "test" },
```

dengan konstanta:

```ts
const TANPA_EMBEDDING = "Kebijakan pengembalian barang berlaku tujuh hari."
```

dan test:

```ts
  it("chunk ber-kata-kunci tanpa embedding tetap bisa ditemukan", async () => {
    // Kasus nyata: dokumen baru diunggah, embedding-nya belum selesai dibuat, lalu
    // pelanggan bertanya. Dengan konstanta RRF 60 chunk ini tidak akan pernah menang
    // melawan chunk mana pun yang punya embedding, sebaik apa pun kecocokan katanya.
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "pengembalian barang",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 3,
    })
    expect(hits.map((h) => h.content)).toContain(TANPA_EMBEDDING)
  })
```

- [ ] **Step 4: Verifikasi, lalu buktikan test barunya bisa gagal**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu kembalikan konstanta RRF ke `60` dan jalankan `pnpm vitest run packages/db/src/store.test.ts`. Test "chunk ber-kata-kunci tanpa embedding" **harus gagal**. Pulihkan ke `10` dan pastikan hijau. Laporkan keduanya.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/store.ts packages/db/src/store.test.ts
git commit -m "fix(db): stop the fusion constant from excluding keyword-only chunks"
```

---

### Task 3: Patok klaim yang tersisa, dan jujurkan yang berlebihan

**Files:**
- Modify: `packages/db/src/tenant.ts`
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`
- Modify: `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

Menutup Minor 6, 7, dan 8.

- [ ] **Step 1: Patok `hnsw.iterative_scan`**

Menghapus baris itu dari `withTenant` sekarang meninggalkan seluruh suite hijau. Tambahkan ke `isolation-guard.test.ts`:

```ts
  it("withTenant menyalakan iterative scan, karena RLS menyaring setelah index scan", async () => {
    // Tanpa ini, `ORDER BY embedding <=> v LIMIT k` bisa mengembalikan kurang dari k
    // baris untuk tenant kecil di tabel besar — kehilangan recall tanpa error apa pun.
    const nilai = await withTenant(db, idA, async (tx) => {
      const r = await tx.execute(sql`SHOW hnsw.iterative_scan`)
      return rowsOf(r)[0]!["hnsw.iterative_scan"] as string
    })
    expect(nilai).toBe("strict_order")
  })
```

Test ini masuk `describe` yang punya `idA`.

- [ ] **Step 2: Buat salah-konfigurasi `GRANT` menjadi fatal, bukan NOTICE**

Kalau role migrasi tidak punya ADMIN OPTION atas `quidchat_app`, migrasi sekarang melaporkan sukses lalu **setiap** permintaan gagal di `SET LOCAL ROLE`. Karena tier 3 belum punya CI (§11.5), tidak ada yang akan menangkapnya sebelum produksi.

Ganti blok `DO $grant$` di `0001_init.sql` sehingga ia **membuktikan** hasilnya:

```sql
DO $grant$
BEGIN
  BEGIN
    EXECUTE format('GRANT quidchat_app TO %I', current_user);
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;  -- mungkin sudah anggota lewat jalur lain
  END;
  -- Bukti, bukan harapan: kalau peran ini tidak bisa diturunkan ke quidchat_app,
  -- SETIAP permintaan akan gagal di withTenant() — jauh lebih baik gagal di sini.
  BEGIN
    EXECUTE 'SET LOCAL ROLE quidchat_app';
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'peran % tidak bisa SET ROLE quidchat_app. Jalankan sebagai superuser: GRANT quidchat_app TO %',
      current_user, current_user;
  END;
END $grant$;
```

- [ ] **Step 3: Jujurkan komentar test perilaku yang berlebihan**

Komentar di `isolation-guard.test.ts` mengklaim test itu menangkap "cacat policy apa pun, pada tabel apa pun, sekarang atau nanti". Setelah Task 1 ia mencakup baca **dan** tulis untuk semua tabel ber-RLS, tapi tetap bukan jaminan menyeluruh. Ganti klaimnya dengan pernyataan yang tepat: ia mengukur akibat pada tabel yang dilindungi RLS, untuk jalur baca dan tulis, dan tidak mencakup view, fungsi `SECURITY DEFINER`, maupun kode aplikasi yang memakai raw handle.

- [ ] **Step 4: Tambahkan test wajib 4–8 ke tabel utang §11.5**

Spec §11.1 berjudul "Delapan test wajib sejak commit pertama", tapi hanya 1, 2, dan 3 yang ada, dan §11.5 tidak menugaskan sisanya. Tambahkan satu baris:

| Utang | Pemilik | Mengapa belum sekarang |
|---|---|---|
| Test wajib #4–#8 (scoping per skill, batas handoff, mode `static` tanpa provider, draft tidak tayang, pewarisan mode) | Rencana multi-skill (#4, #5) dan rencana mode jawaban (#6, #7, #8) | Semuanya butuh tabel `skills`, `skill_sources`, `canned_answers`, dan kolom `answer_mode` yang belum ada. Dicatat di sini supaya "delapan test wajib" tidak dibaca sebagai delapan yang sudah ada |

- [ ] **Step 5: Verifikasi**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu hapus sementara baris `SET LOCAL hnsw.iterative_scan` dari `withTenant` dan pastikan test baru Step 1 **gagal**. Pulihkan.

- [ ] **Step 6: Commit**

```bash
git add packages/db docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md
git commit -m "test(db): pin the iterative-scan setting and make a bad GRANT fatal"
```

---

## Definition of Done

- Kedua serangan Critical ditolak oleh guard **dan** oleh test perilaku, masing-masing dibuktikan bisa gagal.
- Isolasi **tulis** punya test; sebelumnya tidak ada sama sekali.
- Enumerasi tabel memakai RLS, bukan keberadaan kolom — jadi `tenants` tidak lagi luput, dan tabel baru mana pun ikut terjaga otomatis.
- Chunk ber-kata-kunci tanpa embedding bisa ditemukan, dengan test yang gagal kalau konstanta RRF dikembalikan ke 60.
- Tidak ada klaim di kode atau dokumen yang lebih kuat daripada yang dibuktikan test.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 peringatan), `pnpm build` semuanya hijau.
