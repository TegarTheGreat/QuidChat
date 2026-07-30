# Rencana Pengerasan Ronde 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menutup lubang isolasi yang akan terbuka begitu fitur berikutnya menambahkan view, fungsi, skema lain, atau tabel terpartisi — dan memaku empat klaim yang saat ini bisa dirusak tanpa satu pun test gagal.

**Architecture:** Tidak ada modul baru. Memperluas guard migrasi agar tidak lagi hanya melihat tabel biasa di skema `public`, mencabut hak yang tidak seharusnya dimiliki role aplikasi, dan memperkuat test yang selama ini mengukur hal yang salah.

## Mengapa rencana ini ada

Gate adversarial memberi verdict **GO bersyarat**: skema hari ini tidak bisa ditembus, baca maupun tulis. Tapi lima serangan berhasil terhadap jenis objek yang tiga fitur berikutnya pasti akan memperkenalkan. Semuanya diverifikasi dengan menambahkan `0002_provider_layer.sql` yang masuk akal ke salinan repo, lalu menjalankan suite sungguhan — **50/50 tetap hijau setiap kali**.

Akarnya satu: guard **dan** test perilaku sama-sama memfilter `nspname = 'public' AND relkind = 'r'`.

| Objek | Mengapa bocor | Terukur |
|---|---|---|
| `VIEW` | `security_invoker` **mati** secara default, jadi view jalan sebagai owner dan RLS pemanggil tidak berlaku | withTenant(A) melihat "HARGA RAHASIA A" **dan** "HARGA RAHASIA B" |
| `MATERIALIZED VIEW` | Sama, dan `security_invoker` **tidak bisa** memperbaikinya | bocor |
| Fungsi `SECURITY DEFINER` | `EXECUTE` diberikan ke `PUBLIC` secara default | hitungan pesan kedua tenant |
| Tabel di skema non-`public` | Di luar enumerasi | baca **dan** tulis lintas tenant |
| Tabel terpartisi | Parent ber-`relkind='p'` | baca lintas tenant lewat parent |

Dan satu amplifier yang membuat semuanya lebih berbahaya: `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES` sudah memberi DML penuh pada **setiap tabel masa depan**. Jadi guard adalah satu-satunya penghalang antara tabel baru dan kebocoran baca+tulis.

## Global Constraints

Sama dengan ronde sebelumnya, dan tetap mengikat:

- Node `>=22.22.3`. TypeScript strict; `exactOptionalPropertyTypes: true`.
- ESM only; import sumber TypeScript memakai ekstensi `.js`.
- **RLS satu-satunya mekanisme isolasi tenant.** Tidak ada `WHERE tenant_id = ...` pada pembacaan ber-scope.
- Setiap `execute()` lewat `rowsOf()`.
- **Komentar kode dan commit message berbahasa INGGRIS.** Identifier juga Inggris.
  Yang tetap Indonesia HANYA copy produk: system prompt, teks penolakan,
  `high_risk_topics`, dan data fixture — itu isi yang dibaca pelanggan bisnis
  Indonesia, bukan kode.
- Commit tanpa trailer atribusi apa pun. `git add` dengan path eksplisit, **jangan** `git add -A`.
- `pnpm build` masuk verifikasi setiap task.
- Setiap perbaikan yang mengklaim memaku sebuah properti **wajib** dibuktikan dengan merusak kodenya dan menyaksikan test yang bersangkutan gagal. Dua ronde sebelumnya menemukan lima cacat dengan cara ini dan tidak dengan cara lain.

---

### Task 1: Guard yang melihat semua yang bisa bocor

**Files:**
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`

- [ ] **Step 1: Perluas enumerasi guard dari satu jenis objek ke semua yang relevan**

Ganti bagian `WHERE n.nspname = 'public' AND c.relkind = 'r'` di `DO $guard_isolasi$` menjadi enumerasi yang mencakup tabel biasa **dan** tabel terpartisi, di **semua** skema aplikasi:

```sql
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%'
      AND n.nspname NOT LIKE 'pg_toast_temp%'
      AND c.relkind IN ('r', 'p')   -- 'p' = tabel terpartisi; parent-nya BUKAN 'r'
```

`relkind IN ('r','p')` menutup serangan tabel terpartisi: parent-nya `'p'`, jadi guard lama tidak pernah melihatnya sementara `CREATE POLICY ... USING (true)` di sana lolos.

Menghapus penambatan `'public'` menutup serangan skema lain. Terukur: `analytics.leads` bisa dibaca **dan ditulis** lintas tenant, dan `UPDATE ... WHERE tenant_id = B` benar mendarat di baris tenant B.

- [ ] **Step 2: Tambahkan tiga guard baru untuk jenis objek yang RLS tidak melindungi**

Setelah `DO $guard_isolasi$`, tambahkan:

```sql
-- View dan matview TIDAK punya RLS sendiri. Sebuah view berjalan dengan hak PEMILIKNYA
-- kecuali dibuat `WITH (security_invoker = true)`, dan defaultnya MATI. Terukur: satu
-- view sederhana di atas `conversations` membuat tenant A melihat pesan tenant B.
--
-- Matview lebih buruk: `security_invoker` tidak berlaku padanya sama sekali, jadi satu-
-- satunya cara aman adalah tidak memberi hak SELECT kepada role aplikasi.
DO $guard_view$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s', n.nspname, c.relname), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND c.relkind = 'v'
    AND has_table_privilege('quidchat_app', c.oid, 'SELECT')
    AND NOT coalesce(
      (SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
       WHERE option_name = 'security_invoker'), false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'view tanpa security_invoker=true tapi bisa dibaca quidchat_app -> %; RLS pemanggil TIDAK berlaku di sana',
      bad;
  END IF;
END $guard_view$;

DO $guard_matview$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s', n.nspname, c.relname), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND c.relkind = 'm'
    AND has_table_privilege('quidchat_app', c.oid, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'materialized view bisa dibaca quidchat_app -> %; matview tidak mendukung security_invoker, jadi hak SELECT-nya harus dicabut',
      bad;
  END IF;
END $guard_matview$;

-- Fungsi SECURITY DEFINER berjalan sebagai pembuatnya, jadi ia menembus RLS. Dan
-- `EXECUTE` diberikan ke PUBLIC secara DEFAULT — tanpa GRANT apa pun, role aplikasi
-- sudah boleh memanggilnya. Terukur: satu fungsi dashboard mengembalikan hitungan pesan
-- kedua tenant.
--
-- `current_tenant_id()` sendiri dikecualikan: ia memang perlu ada dan ia INVOKER.
DO $guard_secdef$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s', n.nspname, p.proname), ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosecdef
    AND has_function_privilege('quidchat_app', p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'fungsi SECURITY DEFINER bisa dijalankan quidchat_app -> %; fungsi seperti itu menembus RLS',
      bad;
  END IF;
END $guard_secdef$;
```

- [ ] **Step 3: Perbaiki penolakan guard terhadap policy per-command yang SAH**

Guard sekarang menolak `CREATE POLICY ... FOR INSERT WITH CHECK (tenant_id = current_tenant_id())`, karena policy `FOR INSERT` punya `qual` bernilai `NULL` dan pemeriksaannya membandingkan `coalesce(p.qual,'')` dengan harapan. Itu akan menghalangi pekerjaan policy per-command yang sah nanti.

Ubah kedua pemeriksaan agar `NULL` diperlakukan sebagai "tidak berlaku untuk perintah ini", bukan sebagai pelanggaran:

```sql
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = t.skema AND p.tablename = t.nama
            AND p.permissive = 'PERMISSIVE'
            AND p.qual IS NOT NULL AND p.qual <> h.harapan
        ) THEN format('ada policy permissive dengan qual bukan %s', h.harapan)
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = t.skema AND p.tablename = t.nama
            AND p.permissive = 'PERMISSIVE'
            AND p.with_check IS NOT NULL AND p.with_check <> h.harapan
        ) THEN format('ada policy permissive dengan with_check bukan %s', h.harapan)
        WHEN NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = t.skema AND p.tablename = t.nama
            AND p.permissive = 'PERMISSIVE'
            AND (p.qual = h.harapan OR p.with_check = h.harapan)
        ) THEN 'tidak ada policy permissive yang men-scope ke tenant'
```

Cabang terakhir itu penting: tanpanya, policy yang `qual` dan `with_check`-nya sama-sama `NULL` akan lolos ketiga pemeriksaan. Guard harus menuntut **setidaknya satu** policy yang benar-benar men-scope, bukan hanya memastikan tidak ada yang salah.

`pg_policies` sudah memuat `schemaname`, jadi enumerasi lintas skema perlu mencocokkannya — ganti setiap `p.schemaname = 'public'` menjadi `p.schemaname = t.skema`, dan tambahkan `n.nspname AS skema` ke subquery pemilih tabel.

- [ ] **Step 4: Test yang memaku ENUMERASI guard, bukan hanya isinya**

Ini yang paling penting di task ini. Gate menemukan bahwa menulis ulang guard menjadi daftar keras 12 tabel membuat kedelapan test serangan **tetap hijau**, karena semuanya menyasar tabel yang terdaftar. Enumerasinya sendiri tidak dipatok apa pun.

Tambahkan ke `packages/db/src/isolation-guard.test.ts`, di `describe("isolasi tenant di bawah serangan")`:

```ts
  it("guard MENOLAK tabel baru tanpa RLS", async () => {
    // Memaku ENUMERASI guard, bukan isinya. Kalau guard ditulis ulang menjadi daftar
    // keras nama tabel, kedelapan test serangan lain TETAP hijau — semuanya menyasar
    // tabel yang terdaftar. Test inilah yang menangkapnya, dan ia juga menutup skenario
    // paling mungkin di dunia nyata: migrasi berikutnya menambahkan tabel dan lupa RLS.
    await db.execute(sql`CREATE TABLE lupa_rls (tenant_id uuid NOT NULL, isi text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE lupa_rls`)
  })

  it("guard MENOLAK tabel di skema lain tanpa RLS", async () => {
    // Serangan yang terukur bocor BACA DAN TULIS: `analytics.leads`.
    await db.execute(sql`CREATE SCHEMA analytics`)
    await db.execute(sql`CREATE TABLE analytics.leads (tenant_id uuid NOT NULL, catatan text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP SCHEMA analytics CASCADE`)
  })

  it("guard MENOLAK tabel terpartisi tanpa RLS", async () => {
    // Parent tabel terpartisi ber-relkind 'p', bukan 'r', jadi guard lama tidak pernah
    // melihatnya dan `USING (true)` di sana lolos.
    await db.execute(sql`
      CREATE TABLE audit_log (tenant_id uuid NOT NULL, saat timestamptz NOT NULL)
      PARTITION BY RANGE (saat)
    `)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE audit_log`)
  })

  it("guard MENOLAK view yang bisa dibaca app role tanpa security_invoker", async () => {
    const guardView = blokGuard("guard_view")
    await db.execute(sql`CREATE VIEW ringkasan AS SELECT tenant_id, visitor_id FROM conversations`)
    await db.execute(sql`GRANT SELECT ON ringkasan TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).rejects.toThrow()
    // Dan dengan security_invoker menyala, guard-nya lolos.
    await db.execute(sql`DROP VIEW ringkasan`)
    await db.execute(sql`
      CREATE VIEW ringkasan WITH (security_invoker = true) AS
      SELECT tenant_id, visitor_id FROM conversations
    `)
    await db.execute(sql`GRANT SELECT ON ringkasan TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).resolves.toBeDefined()
    await db.execute(sql`DROP VIEW ringkasan`)
  })

  it("guard MENOLAK fungsi SECURITY DEFINER yang bisa dijalankan app role", async () => {
    const guardSecdef = blokGuard("guard_secdef")
    await db.execute(sql`
      CREATE FUNCTION bocor() RETURNS bigint LANGUAGE sql SECURITY DEFINER
      AS 'SELECT count(*) FROM conversations'
    `)
    await expect(db.execute(sql.raw(guardSecdef))).rejects.toThrow()
    await db.execute(sql`DROP FUNCTION bocor()`)
  })
```

- [ ] **Step 5: Verifikasi dan buktikan setiap test bisa gagal**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Untuk **setiap** dari lima test baru, hapus sementara bagian guard yang menangkapnya dan pastikan test itu — dan hanya test itu — gagal. Laporkan kelimanya.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0001_init.sql packages/db/src/isolation-guard.test.ts
git commit -m "fix(db): guard views, functions, other schemas and partitioned tables"
```

---

### Task 2: Test yang mengukur hal yang benar

**Files:**
- Modify: `packages/db/src/isolation-guard.test.ts`
- Modify: `packages/db/src/tenant.test.ts`

- [ ] **Step 1: Balik assertion jumlah tabel yang arahnya salah**

`expect(tabel).toHaveLength(12)` **terbalik**: menambah tabel yang benar terlindungi membuatnya merah (terukur 13), sementara menambah tabel yang **tidak** terlindungi membuatnya tetap hijau — karena tabel tanpa RLS tidak masuk enumerasi. Assertion itu menghukum yang benar dan mengizinkan yang salah.

Ganti dengan batas bawah plus perbandingan terhadap kenyataan:

```ts
    // Batas BAWAH, bukan angka pasti. Menambah tabel ber-RLS yang benar terlindungi
    // seharusnya TIDAK memerahkan test ini; yang harus memerahkannya adalah tabel yang
    // TIDAK terlindungi — dan itu justru tidak masuk enumerasi ini, jadi ditangkap oleh
    // test "guard MENOLAK tabel baru tanpa RLS" di berkas yang sama.
    expect(tabel.length).toBeGreaterThanOrEqual(12)
    // Setiap tabel yang punya kolom tenant_id WAJIB ber-RLS. Ini yang menangkap tabel
    // baru yang lupa dilindungi, dari arah perilaku alih-alih dari arah guard.
    const tanpaRls = rowsOf(
      await db.execute(sql`
        SELECT c.relname AS nama
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT c.relrowsecurity
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
          )
      `),
    ).map((x) => x.nama as string)
    expect(tanpaRls).toEqual([])
```

- [ ] **Step 2: Bandingkan IDENTITAS, bukan hanya jumlah**

Test baca sekarang membandingkan jumlah baris. Satu tenant yang melihat tepat sebanyak baris milik tenant lain akan lolos. Untuk tabel yang punya kolom `tenant_id`, bandingkan himpunan `tenant_id` yang terlihat:

```ts
      // Selain jumlah, periksa bahwa setiap tenant_id yang terlihat memang milik tenant
      // ini. Membandingkan jumlah saja akan meloloskan kasus di mana satu tenant melihat
      // tepat sebanyak baris milik tenant LAIN.
      if (kunci === "tenant_id") {
        const asing = await withTenant(db, idA, async (tx) =>
          rowsOf(
            await tx.execute(
              sql.raw(`SELECT DISTINCT tenant_id::text AS t FROM ${nama}`),
            ),
          ).map((x) => x.t as string),
        )
        for (const t of asing) if (t !== idA) bocor.push(`${nama}: melihat tenant_id ${t}`)
      }
```

- [ ] **Step 3: Patok `set_config(..., true)` — ini risiko produksi, bukan kosmetik**

Mengubah `true` menjadi `false` di `packages/db/src/tenant.ts` meninggalkan **50/50 hijau**. Konsekuensinya di produksi serius: konteks tenant menjadi session-scoped dan **bertahan melewati transaksi** pada koneksi `postgres-js` yang di-pool, sehingga permintaan berikutnya di koneksi yang sama mewarisi tenant permintaan sebelumnya.

Tambahkan ke `packages/db/src/tenant.test.ts`:

```ts
it("konteks tenant tidak bertahan setelah transaksi selesai", async () => {
  const db = await freshPglite()
  const r = await db.execute(sql`INSERT INTO tenants (slug, name) VALUES ('a','A') RETURNING id`)
  const id = rowsOf(r)[0]!.id as string

  await withTenant(db, id, async (tx) => {
    const di = rowsOf(await tx.execute(sql`SELECT current_tenant_id() AS t`))[0]!.t
    expect(di).toBe(id)
  })

  // Di LUAR transaksi konteksnya wajib sudah hilang. Kalau `set_config` dipanggil dengan
  // `false`, nilainya session-scoped dan bertahan — dan pada koneksi yang di-pool itu
  // berarti permintaan berikutnya mewarisi tenant permintaan sebelumnya.
  const luar = rowsOf(await db.execute(sql`SELECT current_tenant_id() AS t`))[0]!.t
  expect(luar).toBeNull()
})
```

- [ ] **Step 4: Perluas cakupan tulis: UPDATE, DELETE, dan pemindahan tenant_id**

Cakupan tulis sekarang tiga `INSERT` di tiga tabel. Tidak ada `UPDATE`, `DELETE`, maupun `UPDATE ... SET tenant_id = <lain>` — yang justru cara paling langsung memindahkan baris ke tenant lain. Tambahkan ke test tulis:

```ts
    // UPDATE baris milik tenant lain harus TIDAK berpengaruh (RLS menyembunyikannya,
    // jadi nol baris terpengaruh), dan memindahkan baris SENDIRI ke tenant lain harus
    // DITOLAK oleh with_check.
    const hasil = await withTenant(db, idA, async (tx) => {
      const upd = await tx.execute(sql.raw(
        `UPDATE conversations SET visitor_id = 'dicuri' WHERE tenant_id = '${idB}'`,
      ))
      return rowsOf(upd).length
    })
    expect(hasil).toBe(0)

    let pindahDitolak = false
    try {
      await withTenant(db, idA, async (tx) => {
        await tx.execute(sql.raw(`UPDATE conversations SET tenant_id = '${idB}'`))
      })
    } catch {
      pindahDitolak = true
    }
    expect(pindahDitolak).toBe(true)
```

- [ ] **Step 5: Verifikasi dan buktikan**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu: ubah `set_config(..., true)` menjadi `false` dan pastikan test Step 3 **gagal**; pulihkan. Laporkan.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/isolation-guard.test.ts packages/db/src/tenant.test.ts
git commit -m "test(db): measure identity and write paths, and pin the transaction-local context"
```

---

### Task 3: Cabut hak yang seharusnya tidak dimiliki role aplikasi

**Files:**
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`
- Modify: `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

- [ ] **Step 1: Cabut DML pada `tenants` dari role aplikasi**

`GRANT ... ON ALL TABLES` memberi role aplikasi `DELETE` dan `UPDATE` pada `tenants`. Terukur: `DELETE FROM tenants` di dalam `withTenant` **berhasil** dan meng-cascade habis seluruh data tenant itu sendiri. `UPDATE tenants SET slug = ...` juga berhasil, dan karena indeks unik pada `slug` bersifat **global**, ia menjadi oracle keberadaan lintas tenant: slug yang sudah dipakai tenant lain menghasilkan duplicate key, slug bebas menghasilkan sukses.

Onboarding tenant baru memang harus memakai raw handle — policy `tenant_self` membuat `INSERT` sebagai `quidchat_app` selalu gagal — jadi role aplikasi tidak butuh hak tulis di sana sama sekali.

Setelah blok `GRANT` yang ada, tambahkan:

```sql
-- Role aplikasi hanya boleh MEMBACA barisnya sendiri di `tenants`, tidak lebih.
-- `GRANT ... ON ALL TABLES` di atas memberinya UPDATE dan DELETE juga, dan keduanya
-- berbahaya: `DELETE FROM tenants` di dalam withTenant berhasil dan meng-cascade habis
-- seluruh data tenant itu; `UPDATE tenants SET slug=...` berhasil, dan karena indeks unik
-- slug bersifat GLOBAL ia menjadi oracle keberadaan lintas tenant — slug milik tenant
-- lain menghasilkan duplicate key, slug bebas menghasilkan sukses.
--
-- Onboarding memang memakai raw handle, karena policy `tenant_self` membuat INSERT
-- sebagai quidchat_app tidak mungkin berhasil. Jadi tidak ada yang hilang.
REVOKE INSERT, UPDATE, DELETE ON tenants FROM quidchat_app;
```

- [ ] **Step 2: Test bahwa hak itu benar tercabut**

```ts
  it("app role tidak bisa menghapus atau mengubah baris tenants", async () => {
    // DELETE dulu berhasil dan meng-cascade habis seluruh data tenant itu sendiri.
    // UPDATE slug dulu berhasil, dan indeks unik slug yang GLOBAL menjadikannya oracle
    // keberadaan lintas tenant.
    for (const perintah of [
      sql`DELETE FROM tenants`,
      sql`UPDATE tenants SET slug = 'apa-pun'`,
    ]) {
      let ditolak = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(perintah)
        })
      } catch {
        ditolak = true
      }
      expect(ditolak).toBe(true)
    }
  })
```

- [ ] **Step 3: Catat bahaya yang tersisa di §11.5, dengan pemiliknya**

Tambahkan baris-baris ini ke tabel utang spec:

| Utang | Pemilik | Mengapa belum sekarang |
|---|---|---|
| Pencarian `admin_sessions` by session id butuh query raw-handle **sebelum** tenant diketahui, dan tidak ada lapis isolasi yang menutupinya | Rencana panel admin | Bahaya isolasi pertama panel admin. Perlu jalur khusus yang sempit dan diaudit, bukan raw handle serba bisa |
| `withTenant` bukan batas terhadap kode aplikasi sendiri: `RESET ROLE` di dalam callback memulihkan superuser | Rencana server | Disiplin kode, bukan lubang skema. Perlu aturan lint atau review, bukan perubahan skema |
| Migrasi menolak diterapkan bila `search_path` deployment tidak memuat `public` | Rencana server | Guard gagal TERTUTUP, jadi aman — tapi pesannya perlu menjelaskan sebabnya |
| Indeks unik `tenants.slug` bersifat global, jadi tetap oracle keberadaan bagi siapa pun yang bisa INSERT | Rencana signup | Setelah Step 1 role aplikasi tidak bisa INSERT; alur signup harus menanganinya sendiri |

- [ ] **Step 4: Verifikasi**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu hapus baris `REVOKE` dan pastikan test Step 2 **gagal**; pulihkan.

- [ ] **Step 5: Commit**

```bash
git add packages/db docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md
git commit -m "fix(db): revoke write access to tenants from the application role"
```

---

## Definition of Done

- Kelima serangan gate ditolak oleh guard, masing-masing dengan test yang dibuktikan bisa gagal.
- Enumerasi guard sendiri dipatok, sehingga menulis ulangnya menjadi daftar keras akan menggagalkan test.
- `set_config(..., true)` dipatok — mengubahnya ke `false` menggagalkan test.
- Assertion jumlah tabel tidak lagi terbalik.
- Isolasi diukur lewat identitas, bukan hanya jumlah, dan mencakup UPDATE, DELETE, serta pemindahan `tenant_id`.
- Role aplikasi tidak punya hak tulis pada `tenants`.
- Bahaya yang tidak ditutup rencana ini tercatat di §11.5 dengan pemilik masing-masing.
