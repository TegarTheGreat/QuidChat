CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id                       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  chat_model                      text NOT NULL DEFAULT 'claude-opus-5',
  rewrite_model                   text NOT NULL DEFAULT 'claude-opus-5',
  embedding_model                 text NOT NULL DEFAULT 'text-embedding-3-small',
  refusal_text                    text NOT NULL DEFAULT 'Maaf, saya belum punya informasi itu. Boleh saya hubungkan ke tim kami?',
  escalation_mode                 text NOT NULL DEFAULT 'collect_contact',
  escalation_target               text,
  monthly_budget_cents            integer NOT NULL DEFAULT 0,
  retention_days                  integer NOT NULL DEFAULT 90,
  high_risk_topics                text[] NOT NULL DEFAULT ARRAY['harga','diskon','garansi','refund','stok','legal'],
  allowed_origins                 text[] NOT NULL DEFAULT ARRAY[]::text[],
  widget_theme                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_handoffs_per_turn           integer NOT NULL DEFAULT 2,
  max_handoffs_per_conversation   integer NOT NULL DEFAULT 5
);

CREATE TABLE admin_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'owner',
  oauth_provider text,
  oauth_subject  text,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)
);

CREATE TABLE admin_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL,
  expires_at    timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, admin_user_id) REFERENCES admin_users(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('url','file','text')),
  uri             text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','indexing','ready','error')),
  last_indexed_at timestamptz,
  error           text,
  UNIQUE (tenant_id, id)
);

CREATE TABLE documents (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  title     text NOT NULL,
  url       text,
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_sources(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE TABLE chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL,
  ordinal         integer NOT NULL,
  content         text NOT NULL,
  embedding       vector(1536),
  embedding_model text NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE INDEX chunks_tenant_idx ON chunks (tenant_id);
CREATE INDEX chunks_tsv_idx    ON chunks USING GIN (tsv);
CREATE INDEX chunks_embed_idx  ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  visitor_id    text NOT NULL,
  handoff_count integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','idle','escalated','closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE TABLE message_citations (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  chunk_id   uuid NOT NULL,
  PRIMARY KEY (message_id, chunk_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, chunk_id) REFERENCES chunks(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE escalations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  reason          text NOT NULL CHECK (reason IN (
                    'no_source','ungrounded','budget_exhausted',
                    'provider_unavailable','schema_invalid',
                    'handoff_limit','visitor_request')),
  resolved_at     timestamptz,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE usage_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model         text NOT NULL,
  input_tokens  integer NOT NULL,
  output_tokens integer NOT NULL,
  cached_tokens integer,
  cost_cents    integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Role aplikasi. Bukan superuser, bukan pemilik tabel, sehingga RLS berlaku.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quidchat_app') THEN
    CREATE ROLE quidchat_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO quidchat_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO quidchat_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO quidchat_app;

-- Role yang dipakai aplikasi untuk konek WAJIB jadi anggota `quidchat_app`, kalau tidak
-- `SET LOCAL ROLE quidchat_app` di withTenant() gagal dengan "permission denied to set
-- role". `quidchat_app` sendiri NOLOGIN dengan sengaja: ia bukan role untuk konek, ia
-- role untuk DITURUNI setelah konek. Baris ini memberi keanggotaan itu ke role yang
-- sedang menjalankan migrasi, yang di tier 1 dan 2 memang role aplikasinya.
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

-- Helper: konteks tenant transaksi saat ini.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('quidchat.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings','admin_users','knowledge_sources','documents','chunks',
    'conversations','messages','message_citations','escalations','admin_sessions','usage_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) '
      || 'WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- tenants sendiri: dibaca lewat id, bukan tenant_id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id());

-- message_citations dan admin_sessions: composite FK menjamin tenant_id cocok dengan parent.
-- Kedua referensi parent mereka sekarang composite dan tidak bisa melintasi tenant.

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
  SELECT string_agg(format('%s: %s', t.nama, a.alasan), ' | ') INTO bad
  FROM (
    SELECT c.relname AS nama,
           n.nspname AS skema,
           -- Kunci tenant tabel ini: `tenant_id` bila ada, kalau tidak `id`.
           -- `tenants` memakai `id` karena ia SENDIRI adalah tenant-nya.
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = n.nspname AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
           ) THEN 'tenant_id' ELSE 'id' END AS kunci,
           c.relrowsecurity AS rls_aktif,
           c.relforcerowsecurity AS rls_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%'
      AND n.nspname NOT LIKE 'pg_toast_temp%'
      AND c.relkind IN ('r', 'p')   -- 'p' = tabel terpartisi; parent-nya BUKAN 'r'
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
          WHERE p.schemaname = t.skema AND p.tablename = t.nama
        ) THEN 'tanpa policy'
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
      END AS alasan
  ) a
  WHERE a.alasan IS NOT NULL;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'isolasi tenant tidak lengkap -> %', bad;
  END IF;
END $guard_isolasi$;

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
