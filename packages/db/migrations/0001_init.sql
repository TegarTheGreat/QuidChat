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
  EXECUTE format('GRANT quidchat_app TO %I', current_user);
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- sudah anggota
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'tidak bisa GRANT quidchat_app TO %; lakukan manual sebagai superuser', current_user;
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

-- Guard: setiap tabel ber-`tenant_id` wajib RLS aktif DAN forced, punya policy, DAN
-- policy itu wajib benar-benar menyebut current_tenant_id(). Pemeriksaan terakhir itu
-- yang membedakan "ada policy" dari "ada policy yang men-scope": `USING (true)` adalah
-- policy yang sah dan sama sekali tidak mengisolasi.
DO $guard$
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
             WHEN NOT EXISTS (
               SELECT 1 FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname
                 AND p.qual LIKE '%current_tenant_id()%'
             ) THEN 'policy tidak menyebut current_tenant_id()'
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
END $guard$;
