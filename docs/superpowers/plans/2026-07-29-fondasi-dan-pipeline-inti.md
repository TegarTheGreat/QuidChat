# QuidChat Rencana 1 — Fondasi & Pipeline Inti

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun monorepo, lapisan database dengan isolasi tenant yang ditegakkan Postgres, dan pipeline menjawab satu-skill yang menolak menjawab klaim bisnis tanpa sumber.

**Architecture:** `@quidchat/db` memegang skema Drizzle, migrasi, dan pabrik koneksi tiga tier (PGlite / embedded-postgres / managed). `@quidchat/core` adalah library murni tanpa HTTP dan tanpa akses `process.env`; ia menerima `Store` dan `Provider` sebagai injeksi sehingga bisa dites tanpa database dan tanpa jaringan. Pipeline berjalan sebagai tahap tetap — retrieve, generate, validasi — dengan maksimum dua ronde retrieval.

**Tech Stack:** TypeScript 5.7+, Node 22+, pnpm workspaces, Drizzle ORM, PGlite + pgvector, vitest 4, oxlint + oxfmt, tsdown.

**Spec:** `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

## Global Constraints

- Node `>=22.22.3`. Deklarasikan di `engines` setiap paket.
- **Setiap dependency langsung di-pin ke versi persis** (`"drizzle-orm": "0.45.2"`, bukan `"^0.45.2"`). Alasan di spec §10.1. **Satu pengecualian:** dependency antar-paket di dalam monorepo memakai `"workspace:*"` — itu bukan versi dari registry, jadi tidak ada permukaan serang supply chain.
- `pnpm-lock.yaml` wajib di-commit. CI memakai `--frozen-lockfile`.
- **`@quidchat/core` tidak boleh meng-import `@quidchat/server`, menyentuh HTTP, membaca `process.env`, atau memulai proses.** Ia hanya boleh meng-import `@quidchat/db` untuk tipe, bukan untuk koneksi.
- Dimensi embedding **1536** di seluruh skema dan test.
- Setiap tabel ber-`tenant_id` wajib `ENABLE ROW LEVEL SECURITY` **dan** `FORCE ROW LEVEL SECURITY`.
- Semua identifier database, nama tabel, nama kolom, dan pesan commit dalam **bahasa Inggris**. Komentar kode dan dokumen boleh Indonesia.
- Commit tanpa trailer atribusi apa pun.

---

## File Structure

**Root**
- `package.json` — workspace root, script agregat
- `pnpm-workspace.yaml` — daftar paket
- `tsconfig.base.json` — compiler option bersama
- `.oxlintrc.json` — aturan lint
- `vitest.config.ts` — konfigurasi test workspace

**`packages/db`** — satu-satunya paket yang tahu cara terhubung ke Postgres
- `src/schema.ts` — seluruh tabel Drizzle
- `src/client.ts` — `createDb()`, memilih driver per tier
- `src/tenant.ts` — `withTenant()`, menyetel role + konteks tenant per transaksi
- `src/migrate.ts` — penerap migrasi
- `src/testing.ts` — `freshPglite()` untuk test
- `migrations/0001_init.sql` — tabel, index, role, policy RLS

**`packages/core`** — library murni
- `src/types.ts` — tipe bersama
- `src/store.ts` — `interface Store`
- `src/provider.ts` — `interface Provider`
- `src/grounding/high-risk.ts` — `detectHighRisk()`
- `src/grounding/validator.ts` — `validateGrounding()`
- `src/prompt/builder.ts` — `buildPrompt()`
- `src/retrieval/hybrid.ts` — SQL hybrid search
- `src/pipeline.ts` — `answer()`
- `src/testing/fakes.ts` — `FakeProvider`, `MemoryStore`

Pemisahan `grounding/` dari `pipeline.ts` disengaja: validator adalah bagian paling penting untuk dites dan paling sering diubah, jadi ia berdiri sendiri tanpa perlu memuat pipeline.

---

## Task 1: Scaffold monorepo

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.oxlintrc.json`
- Create: `vitest.config.ts`
- Create: `.npmrc`

**Interfaces:**
- Consumes: nothing
- Produces: perintah `pnpm test`, `pnpm typecheck`, `pnpm lint` yang berjalan di seluruh workspace

- [ ] **Step 1: Buat `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Buat `package.json` root**

```json
{
  "name": "quidchat",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.22.3" },
  "packageManager": "pnpm@11.15.1",
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "oxlint .",
    "format": "oxfmt ."
  },
  "devDependencies": {
    "@types/node": "26.1.2",
    "oxfmt": "0.60.0",
    "oxlint": "1.75.0",
    "tsdown": "0.22.1",
    "typescript": "5.7.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 3: Buat `.npmrc`**

```
engine-strict=true
```

- [ ] **Step 4: Buat `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "verbatimModuleSyntax": true
  }
}
```

`noUncheckedIndexedAccess` dinyalakan sengaja: pipeline banyak mengindeks array hasil retrieval, dan tanpa opsi ini `candidateSet[0]` bertipe non-nullable padahal bisa `undefined`.

- [ ] **Step 5: Buat `.oxlintrc.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "categories": { "correctness": "error", "suspicious": "warn" },
  "ignorePatterns": ["dist", "node_modules", "migrations"]
}
```

- [ ] **Step 6: Buat `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    testTimeout: 20_000,
  },
})
```

`testTimeout` dinaikkan dari default 5 detik karena test yang menyalakan PGlite perlu memuat WASM pada pemanggilan pertama.

- [ ] **Step 7: Install dan verifikasi**

Run: `pnpm install && pnpm test`
Expected: install sukses; vitest keluar dengan "No test files found" (bukan error konfigurasi).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .oxlintrc.json vitest.config.ts .npmrc pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspace with vitest, oxlint and strict typescript"
```

---

## Task 2: Skema database dan migrasi awal

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0001_init.sql`

**Interfaces:**
- Consumes: workspace dari Task 1
- Produces: `tenants`, `tenantSettings`, `knowledgeSources`, `documents`, `chunks`, `conversations`, `messages`, `messageCitations`, `escalations`, `usageEvents` — objek tabel Drizzle yang diekspor dari `@quidchat/db`

- [ ] **Step 1: Buat `packages/db/package.json`**

```json
{
  "name": "@quidchat/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.22.3" },
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "scripts": {
    "build": "tsdown src/index.ts src/testing.ts --dts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@electric-sql/pglite": "0.5.4",
    "@electric-sql/pglite-pgvector": "0.0.5",
    "drizzle-orm": "0.45.2",
    "postgres": "3.4.9"
  },
  "devDependencies": {
    "drizzle-kit": "0.31.10"
  }
}
```

- [ ] **Step 2: Buat `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Tulis `packages/db/src/schema.ts`**

```ts
import {
  boolean, index, integer, jsonb, pgTable, primaryKey,
  text, timestamp, uuid, vector,
} from "drizzle-orm/pg-core"

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  chatModel: text("chat_model").notNull().default("claude-opus-5"),
  rewriteModel: text("rewrite_model").notNull().default("claude-opus-5"),
  embeddingModel: text("embedding_model").notNull().default("text-embedding-3-small"),
  refusalText: text("refusal_text").notNull()
    .default("Maaf, saya belum punya informasi itu. Boleh saya hubungkan ke tim kami?"),
  escalationMode: text("escalation_mode").notNull().default("collect_contact"),
  escalationTarget: text("escalation_target"),
  monthlyBudgetCents: integer("monthly_budget_cents").notNull().default(0),
  retentionDays: integer("retention_days").notNull().default(90),
  highRiskTopics: text("high_risk_topics").array().notNull()
    .default(["harga", "diskon", "garansi", "refund", "stok", "legal"]),
  allowedOrigins: text("allowed_origins").array().notNull().default([]),
  widgetTheme: jsonb("widget_theme").notNull().default({}),
  maxHandoffsPerTurn: integer("max_handoffs_per_turn").notNull().default(2),
  maxHandoffsPerConversation: integer("max_handoffs_per_conversation").notNull().default(5),
})

export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  status: text("status").notNull().default("pending"),
  lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
  error: text("error"),
})

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => knowledgeSources.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  url: text("url"),
})

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model").notNull(),
}, (t) => [index("chunks_tenant_idx").on(t.tenantId)])

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  visitorId: text("visitor_id").notNull(),
  handoffCount: integer("handoff_count").notNull().default(0),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const messageCitations = pgTable("message_citations", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  chunkId: uuid("chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.messageId, t.chunkId] })])

export const escalations = pgTable("escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
})

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cachedTokens: integer("cached_tokens"),
  costCents: integer("cost_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("owner"),
  oauthProvider: text("oauth_provider"),
  oauthSubject: text("oauth_subject"),
})

export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminUserId: uuid("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
})
```

Tabel `skills`, `skill_sources`, `skill_handoff_edges`, `routing_rules`, dan `handoffs` sengaja **belum** ada di sini — semuanya ditambahkan di Rencana 3 bersama migrasi `0002`. Rencana 1 memakai satu skill implisit.

- [ ] **Step 4: Tulis `packages/db/migrations/0001_init.sql`**

```sql
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
```

`tsv` dibuat sebagai kolom `GENERATED ALWAYS AS ... STORED` supaya tidak mungkin desinkron dari `content` — tidak ada trigger yang bisa lupa dijalankan.

**Versi `@electric-sql/pglite` wajib `0.5.4`, bukan lebih rendah.** `@electric-sql/pglite-pgvector@0.0.5` menyatakan `peerDependencies: {"@electric-sql/pglite": "0.5.4"}` — persyaratan persis, bukan rentang. Ekstensi pgvector adalah WASM yang dibangun terhadap internal pglite versi itu; memasangkannya dengan versi lain lolos `pnpm install` tapi gagal saat runtime di `CREATE EXTENSION vector`, yaitu saat Task 4 pertama kali menyalakan database.

**Ekstensi contrib butuh import eksplisit.** `pg_trgm`, `fuzzystrmatch`, dan `unaccent` memang ikut dalam paket utama, tapi tidak otomatis tersedia — `CREATE EXTENSION pg_trgm` gagal dengan `parse_extension_control_file` kecuali ekstensinya diimpor dan diregistrasi seperti `vector`:

```ts
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm"
await PGlite.create({ extensions: { vector, pg_trgm } })
```

Task 2 belum membutuhkannya (hanya `vector`), tapi dicatat di sini karena mode statis di rencana berikutnya bergantung padanya.

- [ ] **Step 5: Verifikasi migrasi bisa di-parse**

Run: `pnpm install && pnpm --filter @quidchat/db typecheck`
Expected: PASS tanpa error tipe.

- [ ] **Step 6: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): add initial schema and migration"
```

---

## Task 3: Role aplikasi dan policy RLS

**Files:**
- Modify: `packages/db/migrations/0001_init.sql` (tambahkan di akhir berkas)

**Interfaces:**
- Consumes: tabel dari Task 2
- Produces: role `quidchat_app`, policy RLS di setiap tabel ber-`tenant_id`

**Kenapa task ini berdiri sendiri:** ada satu jebakan yang akan membuang berjam-jam kalau tidak ditangani eksplisit. **PGlite berjalan sebagai `postgres`, yaitu superuser — dan superuser melewati RLS sepenuhnya.** Pemilik tabel juga melewati RLS kecuali tabelnya di-`FORCE`. Jadi tanpa role aplikasi terpisah, test isolasi akan mengembalikan baris dari semua tenant dan RLS terlihat "tidak bekerja" padahal policy-nya benar.

- [ ] **Step 1: Tambahkan role dan grant ke akhir `0001_init.sql`**

```sql
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
```

- [ ] **Step 2: Tambahkan RLS dan policy ke akhir `0001_init.sql`**

```sql
-- Helper: konteks tenant transaksi saat ini.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('quidchat.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings','admin_users','knowledge_sources','documents','chunks',
    'conversations','messages','escalations','usage_events'
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

-- message_citations tidak punya tenant_id; ikut induknya.
ALTER TABLE message_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_citations FORCE ROW LEVEL SECURITY;
CREATE POLICY citations_via_message ON message_citations
  USING (EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_citations.message_id
      AND m.tenant_id = current_tenant_id()
  ));

-- admin_sessions juga ikut induknya.
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_via_user ON admin_sessions
  USING (EXISTS (
    SELECT 1 FROM admin_users u
    WHERE u.id = admin_sessions.admin_user_id
      AND u.tenant_id = current_tenant_id()
  ));
```

`current_setting('quidchat.tenant_id', true)` memakai argumen kedua `true` sehingga mengembalikan `NULL` alih-alih melempar error saat konteks belum disetel. Dengan `NULLIF(...)::uuid` jadi `NULL`, dan `tenant_id = NULL` selalu `false` — artinya **lupa menyetel konteks menghasilkan nol baris, bukan seluruh tabel.** Itu arah kegagalan yang benar.

- [ ] **Step 3: Verifikasi SQL valid dengan menerapkannya ke PGlite**

Buat berkas sementara `packages/db/scratch-verify.mjs`:

```js
import { PGlite } from "@electric-sql/pglite"
import { vector } from "@electric-sql/pglite-pgvector"
import { readFileSync } from "node:fs"

const db = await PGlite.create({ extensions: { vector } })
await db.exec(readFileSync("packages/db/migrations/0001_init.sql", "utf8"))
const r = await db.query(
  "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'")
console.log("policy terpasang:", r.rows[0].n)
```

Run: `node packages/db/scratch-verify.mjs`
Expected: `policy terpasang: 12`

- [ ] **Step 4: Hapus berkas sementara**

Run: `rm packages/db/scratch-verify.mjs`

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0001_init.sql
git commit -m "feat(db): add application role and row level security policies"
```

---

## Task 4: Pabrik koneksi dan konteks tenant

**Files:**
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/tenant.ts`
- Create: `packages/db/src/migrate.ts`
- Create: `packages/db/src/testing.ts`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/src/tenant.test.ts`

**Interfaces:**
- Consumes: skema dari Task 2, policy dari Task 3
- Produces:
  - `type QuidDb` — handle Drizzle
  - `createDb(config: DbConfig): Promise<QuidDb>` di mana `DbConfig = { kind: "pglite"; dataDir?: string } | { kind: "postgres"; url: string }`
  - `withTenant<T>(db: QuidDb, tenantId: string, fn: (tx: QuidDb) => Promise<T>): Promise<T>`
  - `applyMigrations(db: QuidDb): Promise<void>`
  - `freshPglite(): Promise<QuidDb>` dari `@quidchat/db/testing`

- [ ] **Step 1: Tulis test isolasi tenant yang gagal**

Buat `packages/db/src/tenant.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { withTenant } from "./tenant.js"
import { chunks, documents, knowledgeSources, tenants } from "./schema.js"

async function seedTenant(db: Awaited<ReturnType<typeof freshPglite>>, slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: slug }).returning()
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: `${slug}.txt`, status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: `${slug} doc` }).returning()
  await db.insert(chunks).values({
    tenantId: t!.id, documentId: d!.id, ordinal: 0,
    content: `rahasia milik ${slug}`, embeddingModel: "test",
  })
  return t!.id
}

describe("isolasi tenant", () => {
  it("tenant hanya melihat chunk miliknya sendiri", async () => {
    const db = await freshPglite()
    const a = await seedTenant(db, "tenant-a")
    const b = await seedTenant(db, "tenant-b")

    const rowsA = await withTenant(db, a, (tx) => tx.select().from(chunks))
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0]!.tenantId).toBe(a)
    expect(rowsA[0]!.content).toContain("tenant-a")

    const rowsB = await withTenant(db, b, (tx) => tx.select().from(chunks))
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0]!.tenantId).toBe(b)
  })

  it("tanpa konteks tenant mengembalikan nol baris, bukan semuanya", async () => {
    const db = await freshPglite()
    await seedTenant(db, "tenant-a")
    await seedTenant(db, "tenant-b")

    const rows = await withTenant(db, "00000000-0000-0000-0000-000000000000",
      (tx) => tx.select().from(chunks))
    expect(rows).toHaveLength(0)
  })
})
```

Test kedua itu penting: ia membuktikan arah kegagalannya aman. Kalau suatu saat seseorang mengubah policy dan lupa konteks jadi berarti "lihat semua", test ini yang menangkapnya.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `pnpm vitest run packages/db/src/tenant.test.ts`
Expected: FAIL — `Cannot find module './testing.js'`

- [ ] **Step 3: Tulis `packages/db/src/client.ts`**

```ts
import { PGlite } from "@electric-sql/pglite"
import { vector } from "@electric-sql/pglite-pgvector"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export type DbConfig =
  | { kind: "pglite"; dataDir?: string }
  | { kind: "postgres"; url: string }

export type QuidDb =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>

export async function createDb(config: DbConfig): Promise<QuidDb> {
  if (config.kind === "pglite") {
    const client = config.dataDir
      ? await PGlite.create(config.dataDir, { extensions: { vector } })
      : await PGlite.create({ extensions: { vector } })
    return drizzlePglite(client, { schema })
  }
  return drizzlePostgres(postgres(config.url, { max: 10 }), { schema })
}
```

- [ ] **Step 4: Tulis `packages/db/src/tenant.ts`**

```ts
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"

/**
 * Menjalankan `fn` di dalam satu transaksi dengan role aplikasi dan konteks
 * tenant terpasang. Keduanya `SET LOCAL`, jadi otomatis lepas saat transaksi
 * selesai — tidak ada kebocoran konteks ke query berikutnya di koneksi yang sama.
 */
export async function withTenant<T>(
  db: QuidDb,
  tenantId: string,
  fn: (tx: QuidDb) => Promise<T>,
): Promise<T> {
  // @ts-expect-error kedua varian driver punya .transaction dengan bentuk sama
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quidchat_app`)
    await tx.execute(sql`SELECT set_config('quidchat.tenant_id', ${tenantId}, true)`)
    return fn(tx as QuidDb)
  })
}
```

`set_config(..., true)` dipakai alih-alih `SET LOCAL quidchat.tenant_id = ...` karena nilainya berasal dari parameter — `SET LOCAL` tidak menerima placeholder, dan menyisipkannya lewat string membuka celah injeksi.

- [ ] **Step 5: Tulis `packages/db/src/migrate.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

export async function applyMigrations(db: QuidDb): Promise<void> {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), "utf8")
    await db.execute(sql.raw(body))
  }
}
```

- [ ] **Step 6: Tulis `packages/db/src/testing.ts`**

```ts
import { createDb, type QuidDb } from "./client.js"
import { applyMigrations } from "./migrate.js"

/** Database PGlite bersih di memori, migrasi sudah diterapkan. */
export async function freshPglite(): Promise<QuidDb> {
  const db = await createDb({ kind: "pglite" })
  await applyMigrations(db)
  return db
}
```

- [ ] **Step 7: Tulis `packages/db/src/index.ts`**

```ts
export * from "./client.js"
export * from "./migrate.js"
export * from "./schema.js"
export * from "./tenant.js"
```

`testing.ts` sengaja tidak diekspor dari `index.ts` — ia punya entry point sendiri (`@quidchat/db/testing`) supaya helper test tidak ikut masuk bundle produksi.

- [ ] **Step 8: Jalankan test**

Run: `pnpm vitest run packages/db/src/tenant.test.ts`
Expected: PASS, kedua test hijau.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): add connection factory, tenant context and isolation tests"
```

---

## Task 5: Tipe inti dan interface

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/store.ts`
- Create: `packages/core/src/provider.ts`
- Create: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing di runtime; hanya tipe
- Produces:
  - `type Segment = { text: string; kind: "general" } | { text: string; kind: "business_claim"; citations: string[] }`
  - `type Answer = { segments: Segment[] }`
  - `type Candidate = { id: string; content: string; documentTitle: string }`
  - `type TenantConfig = { chatModel: string; rewriteModel: string; refusalText: string; highRiskTopics: string[] }`
  - `interface Store` dengan `getTenantConfig`, `searchChunks`, `recordAnswer`, `recordEscalation`
  - `interface Provider` dengan `complete`, `capabilities`

- [ ] **Step 1: Buat `packages/core/package.json`**

```json
{
  "name": "@quidchat/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.22.3" },
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsdown src/index.ts --dts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {}
}
```

**Entry point `./testing` sengaja BELUM didaftarkan di sini.** Berkasnya (`src/testing/fakes.ts`) dibuat di Task 10, dan mendeklarasikan export atau entri build untuk berkas yang belum ada membuat `pnpm build` gagal — `tsdown` menolak input yang tidak ditemukan. Task 10 yang menambahkan keduanya bersamaan dengan berkasnya. Aturan umumnya: **setiap task hanya mendeklarasikan apa yang ia buat.**

`dependencies` kosong bukan kelalaian — `core` adalah library murni. Kalau nanti ada yang menambahkan dependency runtime ke sini, itu sinyal batas arsitektur sedang dilanggar.

- [ ] **Step 2: Buat `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Tulis `packages/core/src/types.ts`**

```ts
export type Segment =
  | { text: string; kind: "general" }
  | { text: string; kind: "business_claim"; citations: string[] }

export type Answer = { segments: Segment[] }

export type Candidate = {
  id: string
  content: string
  documentTitle: string
}

export type TenantConfig = {
  chatModel: string
  rewriteModel: string
  refusalText: string
  highRiskTopics: string[]
}

export type EscalationReason =
  | "no_source"
  | "ungrounded"
  | "budget_exhausted"
  | "provider_unavailable"
  | "schema_invalid"
  | "handoff_limit"
  | "visitor_request"

export type PipelineResult =
  | { kind: "answered"; segments: Segment[]; citedChunkIds: string[] }
  | { kind: "refused"; text: string; reason: EscalationReason }
```

- [ ] **Step 4: Tulis `packages/core/src/store.ts`**

```ts
import type { Candidate, EscalationReason, Segment, TenantConfig } from "./types.js"

export interface Store {
  getTenantConfig(tenantId: string): Promise<TenantConfig>

  /** Hybrid search: vector + full text, sudah di-rerank, dibatasi tenant. */
  searchChunks(args: {
    tenantId: string
    query: string
    embedding: number[]
    limit: number
  }): Promise<Candidate[]>

  recordAnswer(args: {
    tenantId: string
    conversationId: string
    segments: Segment[]
    citedChunkIds: string[]
  }): Promise<void>

  recordEscalation(args: {
    tenantId: string
    conversationId: string
    reason: EscalationReason
  }): Promise<void>
}
```

- [ ] **Step 5: Tulis `packages/core/src/provider.ts`**

```ts
import type { Answer } from "./types.js"

export type PromptParts = {
  /** Stabil per tenant. Titik cache pertama diletakkan di akhir bagian ini. */
  system: string
  /** Riwayat percakapan, hanya bertambah di ujung. */
  history: { role: "user" | "assistant"; content: string }[]
  /** Turn sekarang: konteks hasil retrieve + pertanyaan. Paling volatil. */
  currentTurn: string
}

export type Capabilities = {
  contextWindow: number
  maxOutput: number
  tools: boolean
  vision: boolean
  thinking: boolean
  promptCaching: false | { minPrefixTokens: number; maxBreakpoints: number }
}

export type CompleteResult = {
  answer: Answer
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number | null }
}

export interface Provider {
  readonly id: string
  /** Menghasilkan jawaban terstruktur. Melempar bila model gagal mematuhi schema. */
  complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult>
  embed(args: { model: string; text: string }): Promise<number[]>
  capabilities(model: string): Promise<Capabilities>
}
```

- [ ] **Step 6: Tulis `packages/core/src/index.ts`**

```ts
export * from "./provider.js"
export * from "./store.js"
export * from "./types.js"
```

- [ ] **Step 7: Verifikasi tipe**

Run: `pnpm install && pnpm --filter @quidchat/core typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): add shared types and Store/Provider interfaces"
```

---

## Task 6: Deteksi topik berisiko tinggi

**Files:**
- Create: `packages/core/src/grounding/high-risk.ts`
- Test: `packages/core/src/grounding/high-risk.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `detectHighRisk(text: string, topics: string[]): string[]` — mengembalikan topik yang terdeteksi, array kosong bila tidak ada

- [ ] **Step 1: Tulis test yang gagal**

Buat `packages/core/src/grounding/high-risk.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { detectHighRisk } from "./high-risk.js"

const TOPICS = ["harga", "diskon", "garansi", "refund", "stok", "legal"]

describe("detectHighRisk", () => {
  it("mendeteksi topik yang muncul apa adanya", () => {
    expect(detectHighRisk("Harga produk ini 200 ribu", TOPICS)).toEqual(["harga"])
  })

  it("tidak peduli huruf besar-kecil", () => {
    expect(detectHighRisk("GARANSI resmi 1 tahun", TOPICS)).toEqual(["garansi"])
  })

  it("mengembalikan beberapa topik sekaligus", () => {
    expect(detectHighRisk("ada diskon dan stok masih banyak", TOPICS).sort())
      .toEqual(["diskon", "stok"])
  })

  it("kosong untuk sapaan biasa", () => {
    expect(detectHighRisk("Halo, terima kasih banyak", TOPICS)).toEqual([])
  })

  it("tidak cocok bila topik didahului huruf lain", () => {
    // "legal" tidak boleh terpicu oleh "dilegalisir" atau "ilegal"
    expect(detectHighRisk("dokumen sudah dilegalisir", TOPICS)).toEqual([])
    expect(detectHighRisk("proses ilegal itu", TOPICS)).toEqual([])
    expect(detectHighRisk("saya menghargai bantuannya", TOPICS)).toEqual([])
  })

  it("TETAP cocok bila topik diberi sufiks — kritis untuk bahasa Indonesia", () => {
    expect(detectHighRisk("harganya berapa?", TOPICS)).toEqual(["harga"])
    expect(detectHighRisk("stoknya habis", TOPICS)).toEqual(["stok"])
    expect(detectHighRisk("garansinya berapa lama", TOPICS)).toEqual(["garansi"])
    expect(detectHighRisk("refundnya bisa?", TOPICS)).toEqual(["refund"])
    expect(detectHighRisk("diskonnya ada?", TOPICS)).toEqual(["diskon"])
  })

  it("menghormati daftar topik kustom per tenant", () => {
    expect(detectHighRisk("dosis yang dianjurkan", ["dosis"])).toEqual(["dosis"])
  })
})
```

Dua kelompok kasus itu menarik batas dari arah berlawanan, dan **keduanya wajib lulus bersamaan** — itulah yang menentukan bentuk regex-nya.

Kelompok pertama menuntut penjaga **di depan** topik: pencocokan substring polos akan menandai "dilegalisir" sebagai klaim legal dan menolak jawaban yang sah, sehingga bot menolak hal-hal wajar.

Kelompok kedua melarang penjaga **di belakang**. Dalam bahasa Indonesia sufiks `-nya` menempel langsung ke kata, dan *"harganya berapa?"* kemungkinan cara paling umum pelanggan menanyakan harga. Batas kata di belakang akan melewatkannya — dan konsekuensinya persis kegagalan yang guardrail ini ada untuk mencegah: model menjawab harga dengan label `general`, detektor diam, jawaban tanpa sitasi terkirim ke pelanggan.

Asimetri inilah yang menyelesaikan pilihannya. Untuk sebuah guardrail, **memicu berlebih itu aman** — paling buruk bot meminta sumber untuk kalimat yang tidak memerlukannya. **Kurang memicu tidak aman** — klaim bisnis tanpa sumber lolos ke pelanggan. Jadi ketika ragu, condongkan ke arah mendeteksi.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `pnpm vitest run packages/core/src/grounding/high-risk.test.ts`
Expected: FAIL — `Cannot find module './high-risk.js'`

- [ ] **Step 3: Implementasi minimal**

Buat `packages/core/src/grounding/high-risk.ts`:

```ts
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Mengembalikan topik berisiko tinggi yang muncul di `text` sebagai AWAL kata.
 *
 * Penjaga hanya dipasang di DEPAN topik, bukan di belakang. Itu disengaja:
 * - di depan  -> "dilegalisir", "ilegal", "menghargai" TIDAK terdeteksi, karena
 *                topiknya didahului huruf lain;
 * - di belakang (tidak ada) -> "harganya", "stoknya", "garansinya" TETAP
 *                terdeteksi, dan dalam bahasa Indonesia bentuk bersufiks inilah
 *                yang paling sering dipakai pelanggan.
 *
 * Konsekuensinya kata seperti "hargai" ikut terdeteksi. Itu diterima secara
 * sadar: untuk guardrail, memicu berlebih hanya membuat bot meminta sumber untuk
 * kalimat yang tak memerlukannya, sedangkan kurang memicu meloloskan klaim bisnis
 * tanpa sumber ke pelanggan. Ketika ragu, condong ke arah mendeteksi.
 */
export function detectHighRisk(text: string, topics: string[]): string[] {
  const found: string[] = []
  for (const topic of topics) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(topic)}`, "iu")
    if (re.test(text)) found.push(topic)
  }
  return found
}
```

Lookbehind memakai kelas Unicode `\p{L}\p{N}` alih-alih `\b`, karena `\b` di JavaScript berbasis ASCII dan berperilaku salah pada huruf beraksen.

- [ ] **Step 4: Jalankan test**

Run: `pnpm vitest run packages/core/src/grounding/high-risk.test.ts`
Expected: PASS, keenam test hijau.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/grounding
git commit -m "feat(core): add word-boundary high risk topic detection"
```

---

## Task 7: Validator grounding — test wajib #1

**Files:**
- Create: `packages/core/src/grounding/validator.ts`
- Test: `packages/core/src/grounding/validator.test.ts`

**Interfaces:**
- Consumes: `detectHighRisk` dari Task 6; `Segment`, `Candidate` dari Task 5
- Produces: `validateGrounding(args: { answer: Answer; candidates: Candidate[]; highRiskTopics: string[] }): GroundingVerdict` di mana
  ```ts
  type GroundingVerdict =
    | { ok: true; citedChunkIds: string[] }
    | { ok: false
        violation: "missing_citation" | "unknown_citation"
                 | "unlabelled_high_risk" | "empty_answer"
        detail: string }
  ```

- [ ] **Step 1: Tulis test yang gagal — tabel kasus dari spec §9.1**

Buat `packages/core/src/grounding/validator.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { validateGrounding } from "./validator.js"
import type { Candidate } from "../types.js"

const TOPICS = ["harga", "diskon", "garansi", "refund", "stok", "legal"]
const candidates: Candidate[] = [
  { id: "chunk-1", content: "Garansi resmi 12 bulan.", documentTitle: "Kebijakan" },
  { id: "chunk-2", content: "Harga Rp200.000.", documentTitle: "Katalog" },
]

const run = (segments: Parameters<typeof validateGrounding>[0]["answer"]["segments"]) =>
  validateGrounding({ answer: { segments }, candidates, highRiskTopics: TOPICS })

describe("validateGrounding", () => {
  it("menolak klaim bisnis tanpa sitasi", () => {
    const v = run([{ kind: "business_claim", text: "Garansi 12 bulan.", citations: [] }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("missing_citation")
  })

  it("menolak sitasi di luar candidateSet", () => {
    const v = run([
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-99"] },
    ])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unknown_citation")
  })

  it("menolak segmen general yang menyebut topik berisiko tinggi", () => {
    const v = run([{ kind: "general", text: "Harga kami paling murah kok." }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unlabelled_high_risk")
  })

  it("meloloskan klaim bisnis dengan sitasi valid", () => {
    const v = run([
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual(["chunk-1"])
  })

  it("meloloskan sapaan berlabel general", () => {
    const v = run([{ kind: "general", text: "Halo! Tentu saya bantu." }])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual([])
  })

  it("mengumpulkan sitasi unik dari beberapa segmen", () => {
    const v = run([
      { kind: "general", text: "Halo!" },
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] },
      { kind: "business_claim", text: "Harganya Rp200.000.", citations: ["chunk-2", "chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds.sort()).toEqual(["chunk-1", "chunk-2"])
  })

  it("menolak jawaban kosong", () => {
    const v = run([])
    expect(v.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `pnpm vitest run packages/core/src/grounding/validator.test.ts`
Expected: FAIL — `Cannot find module './validator.js'`

- [ ] **Step 3: Implementasi minimal**

Buat `packages/core/src/grounding/validator.ts`:

```ts
import type { Answer, Candidate } from "../types.js"
import { detectHighRisk } from "./high-risk.js"

export type GroundingVerdict =
  | { ok: true; citedChunkIds: string[] }
  | {
      ok: false
      violation: "missing_citation" | "unknown_citation" | "unlabelled_high_risk" | "empty_answer"
      detail: string
    }

export function validateGrounding(args: {
  answer: Answer
  candidates: Candidate[]
  highRiskTopics: string[]
}): GroundingVerdict {
  const { answer, candidates, highRiskTopics } = args

  if (answer.segments.length === 0) {
    return { ok: false, violation: "empty_answer", detail: "tidak ada segmen" }
  }

  const allowed = new Set(candidates.map((c) => c.id))
  const cited = new Set<string>()

  for (const seg of answer.segments) {
    if (seg.kind === "general") {
      // Label dari model tidak dipercaya untuk topik berisiko tinggi.
      const risky = detectHighRisk(seg.text, highRiskTopics)
      if (risky.length > 0) {
        return {
          ok: false,
          violation: "unlabelled_high_risk",
          detail: `segmen general menyebut: ${risky.join(", ")}`,
        }
      }
      continue
    }

    if (seg.citations.length === 0) {
      return {
        ok: false,
        violation: "missing_citation",
        detail: `klaim bisnis tanpa sitasi: ${seg.text.slice(0, 60)}`,
      }
    }

    for (const id of seg.citations) {
      // Divalidasi terhadap candidateSet, bukan terhadap database. Model bisa
      // mengarang id yang nyata tapi tidak pernah di-retrieve.
      if (!allowed.has(id)) {
        return {
          ok: false,
          violation: "unknown_citation",
          detail: `sitasi di luar candidateSet: ${id}`,
        }
      }
      cited.add(id)
    }
  }

  return { ok: true, citedChunkIds: [...cited] }
}
```

- [ ] **Step 4: Jalankan test**

Run: `pnpm vitest run packages/core/src/grounding/validator.test.ts`
Expected: PASS, ketujuh test hijau.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/grounding/validator.ts packages/core/src/grounding/validator.test.ts
git commit -m "feat(core): add grounding validator with candidate-set citation check"
```

---

## Task 8: Prompt builder — test wajib #3

**Files:**
- Create: `packages/core/src/prompt/builder.ts`
- Test: `packages/core/src/prompt/builder.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `TenantConfig` dari Task 5; `PromptParts` dari Task 5
- Produces:
  - `buildPrompt(args: { config: TenantConfig; history: {role:"user"|"assistant";content:string}[]; candidates: Candidate[]; question: string }): PromptParts`
  - `prefixOf(parts: PromptParts): string` — bagian yang wajib byte-stabil antar pertanyaan

- [ ] **Step 1: Tulis test yang gagal**

Buat `packages/core/src/prompt/builder.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildPrompt, prefixOf } from "./builder.js"
import type { Candidate, TenantConfig } from "../types.js"

const config: TenantConfig = {
  chatModel: "claude-opus-5",
  rewriteModel: "claude-opus-5",
  refusalText: "Maaf, saya belum punya info itu.",
  highRiskTopics: ["harga", "garansi"],
}

const history = [
  { role: "user" as const, content: "halo" },
  { role: "assistant" as const, content: "Halo! Ada yang bisa dibantu?" },
]

const c = (id: string, content: string): Candidate =>
  ({ id, content, documentTitle: "Katalog" })

describe("buildPrompt", () => {
  it("prefix byte-identik untuk pertanyaan berbeda", () => {
    const a = buildPrompt({ config, history, candidates: [c("k1", "Garansi 12 bulan")], question: "garansi?" })
    const b = buildPrompt({ config, history, candidates: [c("k2", "Harga 200rb")], question: "harga?" })
    expect(prefixOf(a)).toBe(prefixOf(b))
  })

  it("prefix berubah bila konfigurasi tenant berubah", () => {
    const a = buildPrompt({ config, history, candidates: [], question: "x" })
    const b = buildPrompt({
      config: { ...config, refusalText: "beda" },
      history, candidates: [], question: "x",
    })
    expect(prefixOf(a)).not.toBe(prefixOf(b))
  })

  it("konteks hasil retrieve masuk turn sekarang, bukan system", () => {
    const p = buildPrompt({
      config, history,
      candidates: [c("k1", "Garansi resmi 12 bulan")],
      question: "garansi berapa lama?",
    })
    expect(p.system).not.toContain("Garansi resmi 12 bulan")
    expect(p.currentTurn).toContain("Garansi resmi 12 bulan")
  })

  it("menyertakan id chunk agar model bisa menyitasinya", () => {
    const p = buildPrompt({ config, history, candidates: [c("k1", "isi")], question: "q" })
    expect(p.currentTurn).toContain("k1")
  })

  it("system prompt memuat teks penolakan dan daftar topik berisiko", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.system).toContain("Maaf, saya belum punya info itu.")
    expect(p.system).toContain("garansi")
  })

  it("riwayat diteruskan apa adanya dan hanya bertambah di ujung", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.history).toEqual(history)
  })
})
```

Test pertama itu **test wajib #3** dari spec §9.1. Ia menangkap masalah yang tanpa test hanya muncul sebagai tagihan membengkak tanpa penjelasan.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

Run: `pnpm vitest run packages/core/src/prompt/builder.test.ts`
Expected: FAIL — `Cannot find module './builder.js'`

- [ ] **Step 3: Implementasi minimal**

Buat `packages/core/src/prompt/builder.ts`:

```ts
import type { PromptParts } from "../provider.js"
import type { Candidate, TenantConfig } from "../types.js"

/**
 * Menyusun prompt agar cache LLM mengena. Urutan render adalah tools → system
 * → messages, dan cache berupa prefix match, jadi yang stabil harus di depan
 * dan yang volatil di belakang.
 *
 * Konteks hasil retrieve TIDAK BOLEH masuk `system` — ia berbeda tiap
 * pertanyaan dan akan membatalkan cache di setiap permintaan.
 */
export function buildPrompt(args: {
  config: TenantConfig
  history: { role: "user" | "assistant"; content: string }[]
  candidates: Candidate[]
  question: string
}): PromptParts {
  const { config, history, candidates, question } = args

  const system = [
    "Kamu adalah asisten layanan pelanggan untuk sebuah bisnis.",
    "",
    "Aturan yang tidak bisa dilanggar:",
    "- Setiap pernyataan tentang bisnis ini (harga, stok, garansi, kebijakan,",
    "  jam operasional, ketersediaan) HANYA boleh berasal dari konteks yang",
    "  diberikan, dan wajib menyertakan id sumbernya.",
    "- Sapaan, ucapan terima kasih, dan bantuan umum tidak perlu sumber.",
    "- Bila konteks tidak memuat jawabannya, jangan menebak. Sampaikan:",
    `  "${config.refusalText}"`,
    "",
    `Topik yang selalu dianggap pernyataan bisnis: ${config.highRiskTopics.join(", ")}.`,
    "",
    "Balas sebagai JSON dengan bentuk:",
    '{"segments":[{"text":"...","kind":"general"},',
    ' {"text":"...","kind":"business_claim","citations":["<id>"]}]}',
  ].join("\n")

  const contextBlock = candidates.length === 0
    ? "(tidak ada konteks yang relevan)"
    : candidates
        .map((c) => `[${c.id}] (${c.documentTitle})\n${c.content}`)
        .join("\n\n")

  const currentTurn = [
    "<konteks>",
    contextBlock,
    "</konteks>",
    "",
    `Pertanyaan pelanggan: ${question}`,
  ].join("\n")

  return { system, history, currentTurn }
}

/**
 * Bagian prompt yang wajib byte-stabil antar pertanyaan dalam percakapan yang
 * sama. Dipakai oleh test regresi cache; jangan memasukkan apa pun yang
 * berubah per permintaan.
 */
export function prefixOf(parts: PromptParts): string {
  return JSON.stringify({ system: parts.system, history: parts.history })
}
```

- [ ] **Step 4: Jalankan test**

Run: `pnpm vitest run packages/core/src/prompt/builder.test.ts`
Expected: PASS, keenam test hijau.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/prompt
git commit -m "feat(core): add cache-aware prompt builder with prefix stability test"
```

---

## Task 9: Hybrid search di Store

**Files:**
- Create: `packages/db/src/store.ts`
- Test: `packages/db/src/store.test.ts`

**Interfaces:**
- Consumes: `withTenant` dari Task 4; `interface Store` dari Task 5
- Produces: `createStore(db: QuidDb): Store` — implementasi `Store` di atas Postgres

Paket `db` yang mengimplementasikan `Store`, bukan `core`, karena SQL adalah urusan database. `core` hanya tahu interface-nya. `@quidchat/db` menambahkan `@quidchat/core` sebagai dependency untuk tipe.

- [ ] **Step 1: Tambahkan dependency core ke db**

Modify `packages/db/package.json`, tambahkan ke `dependencies`:

```json
"@quidchat/core": "workspace:*"
```

- [ ] **Step 2: Tulis test yang gagal**

Buat `packages/db/src/store.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { createStore } from "./store.js"
import { chunks, documents, knowledgeSources, tenants, tenantSettings } from "./schema.js"

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01)
}

async function seed(db: Awaited<ReturnType<typeof freshPglite>>) {
  const [t] = await db.insert(tenants).values({ slug: "toko", name: "Toko" }).returning()
  await db.insert(tenantSettings).values({ tenantId: t!.id })
  const [s] = await db.insert(knowledgeSources)
    .values({ tenantId: t!.id, kind: "text", uri: "a.txt", status: "ready" }).returning()
  const [d] = await db.insert(documents)
    .values({ tenantId: t!.id, sourceId: s!.id, title: "Kebijakan" }).returning()
  await db.insert(chunks).values([
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: "Garansi resmi berlaku 12 bulan sejak pembelian.",
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: "Pengiriman ke Jawa memakan waktu 2 hari.",
      embedding: fakeEmbedding(2), embeddingModel: "test" },
  ])
  return t!.id
}

describe("createStore", () => {
  it("mengembalikan konfigurasi tenant", async () => {
    const db = await freshPglite()
    const tenantId = await seed(db)
    const cfg = await createStore(db).getTenantConfig(tenantId)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.highRiskTopics).toContain("garansi")
  })

  it("menemukan chunk lewat kata kunci", async () => {
    const db = await freshPglite()
    const tenantId = await seed(db)
    const hits = await createStore(db).searchChunks({
      tenantId, query: "garansi", embedding: fakeEmbedding(1), limit: 5,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain("Garansi")
    expect(hits[0]!.documentTitle).toBe("Kebijakan")
  })

  it("tidak mengembalikan apa pun untuk tenant lain", async () => {
    const db = await freshPglite()
    await seed(db)
    const hits = await createStore(db).searchChunks({
      tenantId: "00000000-0000-0000-0000-000000000000",
      query: "garansi", embedding: fakeEmbedding(1), limit: 5,
    })
    expect(hits).toEqual([])
  })
})
```

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

Run: `pnpm install && pnpm vitest run packages/db/src/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 4: Implementasi minimal**

Buat `packages/db/src/store.ts`:

```ts
import type { Candidate, Segment, Store, TenantConfig } from "@quidchat/core"
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"
import { withTenant } from "./tenant.js"

/**
 * Menyeragamkan hasil `execute()` yang bentuknya BERBEDA antar driver:
 * driver PGlite mengembalikan objek ber-`rows`, sedangkan driver postgres-js
 * mengembalikan hasil `client.unsafe()` yang berupa Array (dengan properti
 * tambahan seperti `count` dan `command`, tapi TANPA `.rows`).
 *
 * Tanpa penyeragaman ini, mengakses `.rows` langsung akan bekerja di seluruh
 * test — yang memakai PGlite — lalu menghasilkan `undefined` di tier 3 yang
 * memakai postgres-js. Bug yang lolos setiap test dan hanya muncul di produksi.
 */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export function createStore(db: QuidDb): Store {
  return {
    async getTenantConfig(tenantId: string): Promise<TenantConfig> {
      return withTenant(db, tenantId, async (tx) => {
        const res = await tx.execute(sql`
          SELECT chat_model, rewrite_model, refusal_text, high_risk_topics
          FROM tenant_settings WHERE tenant_id = ${tenantId}
        `)
        const row = rowsOf(res)[0]
        if (!row) throw new Error(`tenant_settings tidak ditemukan: ${tenantId}`)
        return {
          chatModel: row.chat_model as string,
          rewriteModel: row.rewrite_model as string,
          refusalText: row.refusal_text as string,
          highRiskTopics: row.high_risk_topics as string[],
        }
      })
    },

    async searchChunks({ tenantId, query, embedding, limit }): Promise<Candidate[]> {
      const vec = `[${embedding.join(",")}]`
      return withTenant(db, tenantId, async (tx) => {
        // Hybrid: skor keyword (ts_rank) dan skor semantik (1 - cosine distance)
        // dijumlahkan dengan bobot setara, lalu diambil top-k.
        const res = await tx.execute(sql`
          SELECT c.id, c.content, d.title,
                 ts_rank(c.tsv, plainto_tsquery('simple', ${query})) AS kw,
                 1 - (c.embedding <=> ${vec}::vector)                AS sem
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          WHERE c.embedding IS NOT NULL
          ORDER BY (
            ts_rank(c.tsv, plainto_tsquery('simple', ${query}))
            + (1 - (c.embedding <=> ${vec}::vector))
          ) DESC
          LIMIT ${limit}
        `)
        return rowsOf(res).map((r) => ({
          id: r.id as string,
          content: r.content as string,
          documentTitle: r.title as string,
        }))
      })
    },

    async recordAnswer({ tenantId, conversationId, segments, citedChunkIds }) {
      const text = segments.map((s: Segment) => s.text).join(" ")
      await withTenant(db, tenantId, async (tx) => {
        const res = await tx.execute(sql`
          INSERT INTO messages (tenant_id, conversation_id, role, content)
          VALUES (${tenantId}, ${conversationId}, 'assistant', ${text})
          RETURNING id
        `)
        const messageId = rowsOf(res)[0]!.id as string
        for (const chunkId of citedChunkIds) {
          await tx.execute(sql`
            INSERT INTO message_citations (message_id, chunk_id)
            VALUES (${messageId}, ${chunkId})
          `)
        }
      })
    },

    async recordEscalation({ tenantId, conversationId, reason }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO escalations (tenant_id, conversation_id, reason)
          VALUES (${tenantId}, ${conversationId}, ${reason})
        `)
      })
    },
  }
}
```

Tidak ada `WHERE c.tenant_id = ...` di query pencarian — dan itu **disengaja**. RLS yang melakukannya. Menambahkan filter manual akan menyembunyikan kegagalan RLS: kalau policy suatu saat rusak, test tenant lain tetap lulus karena filter aplikasi menutupinya, dan kebocoran baru terlihat di produksi.

- [ ] **Step 5: Ekspor dari index**

Modify `packages/db/src/index.ts`, tambahkan:

```ts
export * from "./store.js"
```

- [ ] **Step 6: Jalankan test**

Run: `pnpm vitest run packages/db/src/store.test.ts`
Expected: PASS, ketiga test hijau.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src packages/db/package.json pnpm-lock.yaml
git commit -m "feat(db): implement Store with hybrid search relying on RLS for scoping"
```

---

## Task 10: Pipeline menjawab — test wajib #2

**Files:**
- Create: `packages/core/src/testing/fakes.ts`
- Create: `packages/core/src/pipeline.ts`
- Test: `packages/core/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `Store`, `Provider` dari Task 5; `validateGrounding` dari Task 7; `buildPrompt` dari Task 8
- Produces:
  - `answer(args: { store: Store; provider: Provider; tenantId: string; conversationId: string; history: {role:"user"|"assistant";content:string}[]; question: string }): Promise<PipelineResult>`
  - `MemoryStore`, `FakeProvider` dari `@quidchat/core/testing`

- [ ] **Step 0: Daftarkan entry point `./testing` yang Task 5 sengaja tunda**

Task 5 tidak mendeklarasikan export ini karena berkasnya belum ada dan `tsdown` menolak input yang tidak ditemukan. Sekarang berkasnya dibuat, jadi daftarkan bersamaan.

Modify `packages/core/package.json`:

```json
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing/fakes.ts" },
  "scripts": {
    "build": "tsdown src/index.ts src/testing/fakes.ts --dts",
```

Jalankan `pnpm build` setelah Step 1 selesai untuk memastikan input barunya ditemukan.

- [ ] **Step 1: Tulis fake untuk test**

Buat `packages/core/src/testing/fakes.ts`:

```ts
import type { Capabilities, CompleteResult, Provider, PromptParts } from "../provider.js"
import type { Store } from "../store.js"
import type { Answer, Candidate, EscalationReason, Segment, TenantConfig } from "../types.js"

export const DEFAULT_CONFIG: TenantConfig = {
  chatModel: "fake-model",
  rewriteModel: "fake-model",
  refusalText: "Maaf, saya belum punya informasi itu.",
  highRiskTopics: ["harga", "diskon", "garansi", "refund", "stok", "legal"],
}

/**
 * Beberapa method di bawah sengaja mendeklarasikan parameter lebih sedikit
 * daripada `Store` — TypeScript mengizinkannya, dan menuliskan parameter yang
 * tidak dipakai hanya menambah derau. Bentuk yang dipanggil pipeline tetap sama.
 */
export class MemoryStore implements Store {
  recordedAnswers: { segments: Segment[]; citedChunkIds: string[] }[] = []
  recordedEscalations: EscalationReason[] = []

  constructor(
    private candidates: Candidate[] = [],
    private config: TenantConfig = DEFAULT_CONFIG,
  ) {}

  async getTenantConfig(): Promise<TenantConfig> {
    return this.config
  }

  async searchChunks(): Promise<Candidate[]> {
    return this.candidates
  }

  async recordAnswer(args: { segments: Segment[]; citedChunkIds: string[] }): Promise<void> {
    this.recordedAnswers.push({ segments: args.segments, citedChunkIds: args.citedChunkIds })
  }

  async recordEscalation(args: { reason: EscalationReason }): Promise<void> {
    this.recordedEscalations.push(args.reason)
  }
}

/** Provider yang mengembalikan jawaban dari daftar yang disiapkan, satu per panggilan. */
export class FakeProvider implements Provider {
  readonly id = "fake"
  /** Panggilan generate. Dipisah dari `embedCalls` supaya test bisa menyatakan
   *  dengan tepat biaya mana yang terjadi dan mana yang tidak. */
  calls: PromptParts[] = []
  embedCalls: string[] = []

  constructor(private answers: Answer[]) {}

  async complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult> {
    this.calls.push(args.prompt)
    const next = this.answers[this.calls.length - 1] ?? this.answers.at(-1)
    if (!next) throw new Error("FakeProvider kehabisan jawaban")
    return {
      answer: next,
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: null },
    }
  }

  async embed(args: { model: string; text: string }): Promise<number[]> {
    this.embedCalls.push(args.text)
    return Array.from({ length: 1536 }, () => 0)
  }

  async capabilities(): Promise<Capabilities> {
    return {
      contextWindow: 200_000, maxOutput: 16_000,
      tools: true, vision: false, thinking: false,
      promptCaching: { minPrefixTokens: 1024, maxBreakpoints: 4 },
    }
  }
}
```

- [ ] **Step 2: Tulis test yang gagal**

Buat `packages/core/src/pipeline.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { answer } from "./pipeline.js"
import { FakeProvider, MemoryStore } from "./testing/fakes.js"
import type { Provider } from "./provider.js"
import type { Candidate } from "./types.js"

const ctx = { tenantId: "t1", conversationId: "c1", history: [], question: "garansi berapa lama?" }
const candidate: Candidate = {
  id: "chunk-1", content: "Garansi resmi 12 bulan.", documentTitle: "Kebijakan",
}

describe("answer", () => {
  it("KB kosong menghasilkan penolakan, bukan jawaban", async () => {
    const store = new MemoryStore([])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 2 tahun.", citations: [] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("no_source")
    expect(store.recordedEscalations).toEqual(["no_source"])
    // Generate TIDAK BOLEH dipanggil: tanpa kandidat, apa pun yang dihasilkan
    // model pasti gagal validasi, jadi memanggilnya hanya membuang biaya.
    expect(provider.calls).toHaveLength(0)
    // Embedding memang terjadi — retrieval membutuhkannya untuk mengetahui
    // bahwa hasilnya kosong. Dinyatakan eksplisit supaya batas klaim ini jelas.
    expect(provider.embedCalls).toHaveLength(1)
  })

  it("menjawab dengan sitasi saat sumbernya ada", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    if (res.kind === "answered") expect(res.citedChunkIds).toEqual(["chunk-1"])
    expect(store.recordedAnswers).toHaveLength(1)
  })

  it("mencoba ronde kedua saat validasi gagal, lalu berhasil", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(provider.calls).toHaveLength(2)
    expect(res.kind).toBe("answered")
  })

  it("berhenti setelah dua ronde dan menolak", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "x", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    // Maksimum dua panggilan — panggilan ketiga tidak boleh terjadi.
    expect(provider.calls).toHaveLength(2)
    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("ungrounded")
  })

  it("menolak dengan schema_invalid saat provider melempar", async () => {
    const store = new MemoryStore([candidate])
    const provider: Provider = {
      id: "broken",
      complete: async () => { throw new Error("model tidak mematuhi schema") },
      embed: async () => Array.from({ length: 1536 }, () => 0),
      capabilities: async () => ({
        contextWindow: 1, maxOutput: 1, tools: false, vision: false,
        thinking: false, promptCaching: false as const,
      }),
    }
    const res = await answer({ store, provider, ...ctx })
    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("schema_invalid")
  })
})
```

Test pertama itu **test wajib #2** dari spec §9.1, dan yang dijaganya adalah regresi paling berbahaya di seluruh pipeline: implementasi yang "berbaik hati" menjawab dari pengetahuan umum model saat basis pengetahuan tidak punya jawabannya.

Dua assertion terakhirnya menarik batas klaim dengan presisi, dan itu disengaja. **Generate tidak boleh dipanggil** — tanpa kandidat, apa pun yang model hasilkan pasti gagal validasi grounding, jadi memanggilnya hanya membuang uang. **Tapi embedding tetap terjadi**, karena retrieval memerlukannya justru untuk mengetahui bahwa hasilnya kosong. Menyatakan keduanya membuat test ini membuktikan apa yang benar-benar bisa dibuktikannya, alih-alih menyiratkan "nol biaya" yang tidak akurat.

Biaya satu embedding hanya muncul saat tenant belum punya konten terindeks — kondisi sementara di masa setup. Menghindarinya butuh query pengecekan tambahan di setiap pesan, dan itu tidak sebanding.

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

Run: `pnpm vitest run packages/core/src/pipeline.test.ts`
Expected: FAIL — `Cannot find module './pipeline.js'`

- [ ] **Step 4: Implementasi minimal**

Buat `packages/core/src/pipeline.ts`:

```ts
import { validateGrounding } from "./grounding/validator.js"
import { buildPrompt } from "./prompt/builder.js"
import type { Provider } from "./provider.js"
import type { Store } from "./store.js"
import type { EscalationReason, PipelineResult } from "./types.js"

const MAX_ROUNDS = 2
const CANDIDATE_LIMIT = 8

export async function answer(args: {
  store: Store
  provider: Provider
  tenantId: string
  conversationId: string
  history: { role: "user" | "assistant"; content: string }[]
  question: string
}): Promise<PipelineResult> {
  const { store, provider, tenantId, conversationId, history, question } = args
  const config = await store.getTenantConfig(tenantId)

  const refuse = async (reason: EscalationReason): Promise<PipelineResult> => {
    await store.recordEscalation({ tenantId, conversationId, reason })
    return { kind: "refused", text: config.refusalText, reason }
  }

  let embedding: number[]
  try {
    embedding = await provider.embed({ model: config.chatModel, text: question })
  } catch {
    return refuse("provider_unavailable")
  }

  const candidates = await store.searchChunks({
    tenantId, query: question, embedding, limit: CANDIDATE_LIMIT,
  })

  // Tanpa kandidat, tidak ada yang bisa disitasi. Menolak di sini menghemat
  // satu panggilan LLM yang pasti gagal validasi.
  if (candidates.length === 0) return refuse("no_source")

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prompt = buildPrompt({ config, history, candidates, question })

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
      await store.recordAnswer({
        tenantId, conversationId,
        segments: result.answer.segments,
        citedChunkIds: verdict.citedChunkIds,
      })
      return {
        kind: "answered",
        segments: result.answer.segments,
        citedChunkIds: verdict.citedChunkIds,
      }
    }
  }

  return refuse("ungrounded")
}
```

- [ ] **Step 5: Ekspor pipeline dari index**

Modify `packages/core/src/index.ts`, tambahkan:

```ts
export * from "./grounding/high-risk.js"
export * from "./grounding/validator.js"
export * from "./pipeline.js"
export * from "./prompt/builder.js"
```

- [ ] **Step 6: Jalankan seluruh test**

Run: `pnpm test`
Expected: PASS semua — **6 berkas test, 29 test** hijau (`tenant` 2, `high-risk` 6, `validator` 7, `builder` 6, `store` 3, `pipeline` 5).

- [ ] **Step 7: Verifikasi batas arsitektur ditegakkan**

Run: `grep -rn "process.env\|require('http')\|from \"http\"\|from \"node:http\"" packages/core/src`
Expected: nol hasil. `core` tidak boleh menyentuh env atau HTTP.

- [ ] **Step 8: Typecheck dan lint**

Run: `pnpm typecheck && pnpm lint`
Expected: keduanya PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add answer pipeline with two-round retrieval limit"
```

---

## Definition of Done untuk Rencana 1

Kriteria dari spec §11 yang tercapai di rencana ini:

- **§11.5** — Dua tenant di satu instalasi tidak bisa melihat data satu sama lain, dibuktikan test RLS (Task 4).
- **§11.10 sebagian** — Tiga dari lima test wajib hijau:
  - Validator grounding, tabel kasus lengkap (Task 7)
  - KB kosong → penolakan (Task 10)
  - Stabilitas prefix prompt (Task 8)

Test wajib #4 (scoping pengetahuan per skill) dan #5 (batas handoff) menunggu Rencana 3, karena tabel `skills` belum ada.

Perintah verifikasi akhir:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Semua harus hijau sebelum Rencana 2 dimulai.
