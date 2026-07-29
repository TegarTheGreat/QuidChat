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
  UNIQUE (tenant_id, email)
);

CREATE TABLE admin_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL
);

CREATE TABLE knowledge_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('url','file','text')),
  uri             text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','indexing','ready','error')),
  last_indexed_at timestamptz,
  error           text
);

CREATE TABLE documents (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  title     text NOT NULL,
  url       text
);

CREATE TABLE chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  content         text NOT NULL,
  embedding       vector(1536),
  embedding_model text NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
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
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_citations (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_id   uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, chunk_id)
);

CREATE TABLE escalations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason          text NOT NULL CHECK (reason IN (
                    'no_source','ungrounded','budget_exhausted',
                    'provider_unavailable','schema_invalid',
                    'handoff_limit','visitor_request')),
  resolved_at     timestamptz
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
