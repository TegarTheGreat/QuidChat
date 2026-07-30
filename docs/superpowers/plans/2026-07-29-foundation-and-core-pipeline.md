# QuidChat Plan 1 — Foundation & Core Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Historical record.** This plan describes work that is complete. The code has moved on since
> it was written — most visibly, the codebase was translated to English after these tasks landed,
> so the Indonesian strings in the code samples below are what was built at the time, not what is
> in the repository now. Read it for the reasoning behind a decision; read the code for what the
> code does.


**Goal:** Build the monorepo, a database layer with tenant isolation enforced by Postgres, and a single-skill answering pipeline that refuses to answer unsourced business claims.

**Architecture:** `@quidchat/db` holds the Drizzle schema, migrations, and a two-tier connection factory (PGlite / postgres); the embedded-postgres tier is a process-lifecycle concern that belongs to the `quidchat serve` plan and will reuse `kind: "postgres"` once the process is running. `@quidchat/core` is a pure library with no HTTP and no access to `process.env`; it receives `Store` and `Provider` as injected dependencies so it can be tested without a database and without a network. The pipeline runs as fixed stages — retrieve, generate, validate — with a maximum of two retrieval rounds.

**Tech Stack:** TypeScript 5.7+, Node 22+, pnpm workspaces, Drizzle ORM, PGlite + pgvector, vitest 4, oxlint + oxfmt, tsdown.

**Spec:** `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

## Global Constraints

- Node `>=22.22.3`. Declare it in `engines` for every package.
- **Every direct dependency is pinned to an exact version** (`"drizzle-orm": "0.45.2"`, not `"^0.45.2"`). Rationale in spec §10.1. **One exception:** inter-package dependencies within the monorepo use `"workspace:*"` — that isn't a registry version, so there's no supply-chain attack surface there.
- `pnpm-lock.yaml` must be committed. CI uses `--frozen-lockfile`.
- **`@quidchat/core` must not import `@quidchat/server`, touch HTTP, read `process.env`, or start a process.** It may only import `@quidchat/db` for types, never for a connection.
- Embedding dimension **1536** throughout the schema and tests.
- Every table with a `tenant_id` must have both `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`.
- All database identifiers, table names, column names, and commit messages are in **English**. Code comments and documents may be in Indonesian.
- Commits carry no attribution trailer of any kind.

---

## File Structure

**Root**
- `package.json` — workspace root, aggregate scripts
- `pnpm-workspace.yaml` — package listing
- `tsconfig.base.json` — shared compiler options
- `.oxlintrc.json` — lint rules
- `vitest.config.ts` — workspace test configuration

**`packages/db`** — the only package that knows how to connect to Postgres
- `src/schema.ts` — all Drizzle tables
- `src/client.ts` — `createDb()`, picks the driver per tier
- `src/tenant.ts` — `withTenant()`, sets the role + tenant context per transaction
- `src/migrate.ts` — migration runner
- `src/testing.ts` — `freshPglite()` for tests
- `migrations/0001_init.sql` — tables, indexes, role, RLS policies

**`packages/core`** — pure library
- `src/types.ts` — shared types
- `src/store.ts` — `interface Store`
- `src/provider.ts` — `interface Provider`
- `src/grounding/high-risk.ts` — `detectHighRisk()`
- `src/grounding/validator.ts` — `validateGrounding()`
- `src/prompt/builder.ts` — `buildPrompt()`
- `src/retrieval/hybrid.ts` — hybrid search SQL
- `src/pipeline.ts` — `answer()`
- `src/testing/fakes.ts` — `FakeProvider`, `MemoryStore`

Separating `grounding/` from `pipeline.ts` is deliberate: the validator is the single most important thing to test and the thing most often changed, so it stands on its own without needing to load the pipeline.

---

## Task 1: Scaffold the monorepo

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.oxlintrc.json`
- Create: `vitest.config.ts`
- Create: `.npmrc`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm test`, `pnpm typecheck`, `pnpm lint` commands that run across the whole workspace

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create root `package.json`**

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

- [ ] **Step 3: Create `.npmrc`**

```
engine-strict=true
```

- [ ] **Step 4: Create `tsconfig.base.json`**

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

`noUncheckedIndexedAccess` is turned on deliberately: the pipeline indexes into retrieval-result arrays a lot, and without this option `candidateSet[0]` would type as non-nullable even though it can be `undefined`.

- [ ] **Step 5: Create `.oxlintrc.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "categories": { "correctness": "error", "suspicious": "warn" },
  "ignorePatterns": ["dist", "node_modules", "migrations"]
}
```

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Building the Postgres WASM binary and then applying migrations takes about 7 seconds.
    testTimeout: 20_000,
    // `hookTimeout` does NOT inherit `testTimeout` — its default stays 10 seconds.
    // A test that sets up one shared database in `beforeAll` blows past that
    // (build + seed), and the failure shows up as "Hook timed out in 10000ms"
    // which never mentions the database at all.
    hookTimeout: 60_000,
  },
})
```

`testTimeout` is raised from the default 5 seconds because tests that start PGlite need to load WASM on the first call. `hookTimeout` is raised separately because vitest does **not** derive it from `testTimeout`: the two are independent, and a `beforeAll` that builds a database will time out at 10 seconds even with `testTimeout` at 20 seconds. The symptom is misleading — the message only says "Hook timed out", with no mention of the database.

- [ ] **Step 7: Install and verify**

Run: `pnpm install && pnpm test`
Expected: install succeeds; vitest exits with "No test files found" (not a configuration error).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .oxlintrc.json vitest.config.ts .npmrc pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspace with vitest, oxlint and strict typescript"
```

---

## Task 2: Database schema and initial migration

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0001_init.sql`

**Interfaces:**
- Consumes: workspace from Task 1
- Produces: `tenants`, `tenantSettings`, `knowledgeSources`, `documents`, `chunks`, `conversations`, `messages`, `messageCitations`, `escalations`, `usageEvents` — Drizzle table objects exported from `@quidchat/db`

- [ ] **Step 1: Create `packages/db/package.json`**

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

- [ ] **Step 2: Create `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/db/src/schema.ts`**

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

The `skills`, `skill_sources`, `skill_handoff_edges`, `routing_rules`, and `handoffs` tables are deliberately **not** here yet — they are all added in Plan 3 together with migration `0002`. Plan 1 works with a single implicit skill.

- [ ] **Step 4: Write `packages/db/migrations/0001_init.sql`**

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

`tsv` is created as a `GENERATED ALWAYS AS ... STORED` column precisely so it can never drift out of sync from `content` — there is no trigger that could be forgotten.

**`@electric-sql/pglite` must be exactly `0.5.4`, not lower.** `@electric-sql/pglite-pgvector@0.0.5` declares `peerDependencies: {"@electric-sql/pglite": "0.5.4"}` — an exact requirement, not a range. The pgvector extension is WASM built against that version's pglite internals; pairing it with a different version passes `pnpm install` but fails at runtime on `CREATE EXTENSION vector`, which is exactly when Task 4 first starts the database.

**Contrib extensions need an explicit import.** `pg_trgm`, `fuzzystrmatch`, and `unaccent` do ship inside the main package, but they are not automatically available — `CREATE EXTENSION pg_trgm` fails with `parse_extension_control_file` unless the extension is imported and registered just like `vector`:

```ts
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm"
await PGlite.create({ extensions: { vector, pg_trgm } })
```

Task 2 doesn't need it yet (only `vector`), but it's noted here because the static mode in a later plan depends on it.

- [ ] **Step 5: Verify the migration parses**

Run: `pnpm install && pnpm --filter @quidchat/db typecheck`
Expected: PASS with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): add initial schema and migration"
```

---

## Task 3: Application role and RLS policies

**Files:**
- Modify: `packages/db/migrations/0001_init.sql` (append to the end of the file)

**Interfaces:**
- Consumes: tables from Task 2
- Produces: role `quidchat_app`, RLS policy on every table with a `tenant_id`

**Why this task stands on its own:** there is one trap that will burn hours if it isn't handled explicitly. **PGlite runs as `postgres`, i.e. a superuser — and a superuser bypasses RLS entirely.** A table's owner also bypasses RLS unless the table is `FORCE`d. So without a separate application role, isolation tests will return rows from every tenant and RLS will look "broken" even though the policy itself is correct.

- [ ] **Step 1: Append the role and grants to `0001_init.sql`**

```sql
-- Application role. Not a superuser, not a table owner, so RLS actually applies.
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

- [ ] **Step 2: Append RLS and policies to `0001_init.sql`**

```sql
-- Helper: the current transaction's tenant context.
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

-- tenants itself: read via id, not tenant_id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id());

-- message_citations has no tenant_id; it follows its parent.
ALTER TABLE message_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_citations FORCE ROW LEVEL SECURITY;
CREATE POLICY citations_via_message ON message_citations
  USING (EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_citations.message_id
      AND m.tenant_id = current_tenant_id()
  ));

-- admin_sessions also follows its parent.
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_via_user ON admin_sessions
  USING (EXISTS (
    SELECT 1 FROM admin_users u
    WHERE u.id = admin_sessions.admin_user_id
      AND u.tenant_id = current_tenant_id()
  ));
```

`current_setting('quidchat.tenant_id', true)` passes `true` as the second argument so it returns `NULL` instead of raising when the context hasn't been set. With `NULLIF(...)::uuid` that becomes `NULL`, and `tenant_id = NULL` is always `false` — meaning **forgetting to set the context yields zero rows, not the whole table.** That's the correct failure direction.

- [ ] **Step 3: Verify the SQL is valid by applying it to PGlite**

Create a scratch file `packages/db/scratch-verify.mjs`:

```js
import { PGlite } from "@electric-sql/pglite"
import { vector } from "@electric-sql/pglite-pgvector"
import { readFileSync } from "node:fs"

const db = await PGlite.create({ extensions: { vector } })
await db.exec(readFileSync("packages/db/migrations/0001_init.sql", "utf8"))
const r = await db.query(
  "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'")
console.log("policies installed:", r.rows[0].n)
```

Run: `node packages/db/scratch-verify.mjs`
Expected: `policies installed: 12`

- [ ] **Step 4: Delete the scratch file**

Run: `rm packages/db/scratch-verify.mjs`

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0001_init.sql
git commit -m "feat(db): add application role and row level security policies"
```

---

## Task 4: Connection factory and tenant context

**Files:**
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/tenant.ts`
- Create: `packages/db/src/migrate.ts`
- Create: `packages/db/src/testing.ts`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/src/tenant.test.ts`

**Interfaces:**
- Consumes: schema from Task 2, policies from Task 3
- Produces:
  - `type QuidDb` — Drizzle handle
  - `createDb(config: DbConfig): Promise<QuidDb>` where `DbConfig = { kind: "pglite"; dataDir?: string } | { kind: "postgres"; url: string }`
  - `withTenant<T>(db: QuidDb, tenantId: string, fn: (tx: QuidDb) => Promise<T>): Promise<T>`
  - `applyMigrations(db: QuidDb): Promise<void>`
  - `freshPglite(): Promise<QuidDb>` from `@quidchat/db/testing`

- [ ] **Step 1: Write a failing tenant isolation test**

Create `packages/db/src/tenant.test.ts`:

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

describe("tenant isolation", () => {
  it("a tenant only sees its own chunks", async () => {
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

  it("with no tenant context returns zero rows, not all of them", async () => {
    const db = await freshPglite()
    await seedTenant(db, "tenant-a")
    await seedTenant(db, "tenant-b")

    const rows = await withTenant(db, "00000000-0000-0000-0000-000000000000",
      (tx) => tx.select().from(chunks))
    expect(rows).toHaveLength(0)
  })
})
```

That second test matters: it proves the failure direction is safe. If someone ever changes a policy and forgets the context ends up meaning "see everything", this is the test that catches it.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run packages/db/src/tenant.test.ts`
Expected: FAIL — `Cannot find module './testing.js'`

- [ ] **Step 3: Write `packages/db/src/client.ts`**

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

- [ ] **Step 4: Write `packages/db/src/tenant.ts`**

```ts
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"

/**
 * Runs `fn` inside a single transaction with the application role and tenant
 * context set. Both are `SET LOCAL`, so they automatically drop off once the
 * transaction ends — no context leaks to the next query on the same connection.
 */
export async function withTenant<T>(
  db: QuidDb,
  tenantId: string,
  fn: (tx: QuidDb) => Promise<T>,
): Promise<T> {
  // @ts-expect-error both driver variants have a .transaction with the same shape
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quidchat_app`)
    await tx.execute(sql`SELECT set_config('quidchat.tenant_id', ${tenantId}, true)`)
    return fn(tx as QuidDb)
  })
}
```

`set_config(..., true)` is used instead of `SET LOCAL quidchat.tenant_id = ...` because the value comes from a parameter — `SET LOCAL` doesn't accept a placeholder, and splicing it in via string concatenation would open an injection hole.

- [ ] **Step 5: Write `packages/db/src/migrate.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

export async function applyMigrations(db: QuidDb): Promise<void> {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).toSorted()
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), "utf8")
    await db.execute(sql.raw(body))
  }
}
```

- [ ] **Step 6: Write `packages/db/src/testing.ts`**

```ts
import { createDb, type QuidDb } from "./client.js"
import { applyMigrations } from "./migrate.js"

/** A clean in-memory PGlite database with migrations already applied. */
export async function freshPglite(): Promise<QuidDb> {
  const db = await createDb({ kind: "pglite" })
  await applyMigrations(db)
  return db
}
```

- [ ] **Step 7: Write `packages/db/src/index.ts`**

```ts
export * from "./client.js"
export * from "./migrate.js"
export * from "./schema.js"
export * from "./tenant.js"
```

`testing.ts` is deliberately not re-exported from `index.ts` — it has its own entry point (`@quidchat/db/testing`) so test helpers don't end up in the production bundle.

- [ ] **Step 8: Run the test**

Run: `pnpm vitest run packages/db/src/tenant.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): add connection factory, tenant context and isolation tests"
```

---

## Task 5: Core types and interfaces

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/store.ts`
- Create: `packages/core/src/provider.ts`
- Create: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing at runtime; types only
- Produces:
  - `type Segment = { text: string; kind: "general" } | { text: string; kind: "business_claim"; citations: string[] }`
  - `type Answer = { segments: Segment[] }`
  - `type Candidate = { id: string; content: string; documentTitle: string }`
  - `type TenantConfig = { chatModel: string; rewriteModel: string; embeddingModel: string; refusalText: string; highRiskTopics: string[] }`
  - `interface Store` with `getTenantConfig`, `searchChunks`, `recordAnswer`, `recordEscalation`
  - `interface Provider` with `complete`, `capabilities`

- [ ] **Step 1: Create `packages/core/package.json`**

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

**The `./testing` entry point is deliberately NOT registered here yet.** Its file (`src/testing/fakes.ts`) is created in Task 10, and declaring a package export or a build entry for a file that doesn't exist yet breaks `pnpm build` — `tsdown` refuses input it can't find. Task 10 adds both together with the file itself. The general rule: **each task declares only what it creates.**

The empty `dependencies` isn't an oversight — `core` is a pure library. If a runtime dependency ever gets added here, that's a signal the architectural boundary is being violated.

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/core/src/types.ts`**

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
  /** Embedding model. Kept SEPARATE from `chatModel` — embedding with the
   *  chat model's id will be rejected by a real provider. */
  embeddingModel: string
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

- [ ] **Step 4: Write `packages/core/src/store.ts`**

```ts
import type { Candidate, EscalationReason, Segment, TenantConfig } from "./types.js"

export interface Store {
  getTenantConfig(tenantId: string): Promise<TenantConfig>

  /** Hybrid search: vector + full text, already reranked, scoped to the tenant. */
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

- [ ] **Step 5: Write `packages/core/src/provider.ts`**

```ts
import type { Answer } from "./types.js"

export type PromptParts = {
  /** Stable per tenant. The first cache breakpoint sits at the end of this part. */
  system: string
  /** Conversation history, only ever grows at the tail. */
  history: { role: "user" | "assistant"; content: string }[]
  /** The current turn: retrieved context + question. Most volatile. */
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
  /** Produces a structured answer. Throws if the model fails to comply with the schema. */
  complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult>
  embed(args: { model: string; text: string }): Promise<number[]>
  capabilities(model: string): Promise<Capabilities>
}
```

- [ ] **Step 6: Write `packages/core/src/index.ts`**

```ts
export * from "./provider.js"
export * from "./store.js"
export * from "./types.js"
```

- [ ] **Step 7: Verify types**

Run: `pnpm install && pnpm --filter @quidchat/core typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): add shared types and Store/Provider interfaces"
```

---

## Task 6: High-risk topic detection

**Files:**
- Create: `packages/core/src/grounding/high-risk.ts`
- Test: `packages/core/src/grounding/high-risk.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `detectHighRisk(text: string, topics: string[]): string[]` — returns the topics detected, an empty array if none

- [ ] **Step 1: Write a failing test**

Create `packages/core/src/grounding/high-risk.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { detectHighRisk } from "./high-risk.js"

const TOPICS = ["harga", "diskon", "garansi", "refund", "stok", "legal"]

describe("detectHighRisk", () => {
  it("detects a topic that appears verbatim", () => {
    expect(detectHighRisk("Harga produk ini 200 ribu", TOPICS)).toEqual(["harga"])
  })

  it("is case-insensitive", () => {
    expect(detectHighRisk("GARANSI resmi 1 tahun", TOPICS)).toEqual(["garansi"])
  })

  it("returns several topics at once", () => {
    expect(detectHighRisk("ada diskon dan stok masih banyak", TOPICS).toSorted())
      .toEqual(["diskon", "stok"])
  })

  it("is empty for an ordinary greeting", () => {
    expect(detectHighRisk("Halo, terima kasih banyak", TOPICS)).toEqual([])
  })

  it("does not match when the topic is preceded by other letters", () => {
    // "legal" must not be triggered by "dilegalisir" or "ilegal"
    expect(detectHighRisk("dokumen sudah dilegalisir", TOPICS)).toEqual([])
    expect(detectHighRisk("proses ilegal itu", TOPICS)).toEqual([])
    expect(detectHighRisk("saya menghargai bantuannya", TOPICS)).toEqual([])
  })

  it("STILL matches when the topic carries a suffix — critical for Indonesian", () => {
    expect(detectHighRisk("harganya berapa?", TOPICS)).toEqual(["harga"])
    expect(detectHighRisk("stoknya habis", TOPICS)).toEqual(["stok"])
    expect(detectHighRisk("garansinya berapa lama", TOPICS)).toEqual(["garansi"])
    expect(detectHighRisk("refundnya bisa?", TOPICS)).toEqual(["refund"])
    expect(detectHighRisk("diskonnya ada?", TOPICS)).toEqual(["diskon"])
  })

  it("honors a per-tenant custom topic list", () => {
    expect(detectHighRisk("dosis yang dianjurkan", ["dosis"])).toEqual(["dosis"])
  })
})
```

The two groups of cases draw the boundary from opposite directions, and **both must pass simultaneously** — that is exactly what shapes the regex.

The first group demands a guard **in front of** the topic: plain substring matching would flag "dilegalisir" as a legal claim and reject a legitimate answer, so the bot would refuse perfectly ordinary things.

The second group forbids a guard **behind** the topic. In Indonesian the suffix `-nya` attaches directly to the word, and *"harganya berapa?"* ("what's the price?") is probably the single most common way a customer asks about price. A trailing word boundary would miss it — and the consequence is exactly the failure this guardrail exists to prevent: the model answers the price with a `general` label, the detector stays silent, and an uncited answer reaches the customer.

That asymmetry is what settles the design. For a guardrail, **over-triggering is safe** — worst case the bot asks for a source for a sentence that didn't need one. **Under-triggering is not safe** — an unsourced business claim slips through to the customer. So when in doubt, lean toward detecting.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run packages/core/src/grounding/high-risk.test.ts`
Expected: FAIL — `Cannot find module './high-risk.js'`

- [ ] **Step 3: Minimal implementation**

Create `packages/core/src/grounding/high-risk.ts`:

```ts
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Returns the high-risk topics that appear in `text` as the START of a word.
 *
 * The guard is only placed in FRONT of the topic, never behind it. That's
 * deliberate:
 * - in front  -> "dilegalisir", "ilegal", "menghargai" are NOT detected, because
 *                the topic is preceded by other letters;
 * - behind (absent) -> "harganya", "stoknya", "garansinya" ARE STILL detected,
 *                and in Indonesian this suffixed form is the one customers use
 *                most often.
 *
 * The consequence is that a word like "hargai" ("to appreciate") also gets
 * flagged. That's accepted knowingly: for a guardrail, over-triggering only
 * makes the bot ask for a source for a sentence that didn't need one, while
 * under-triggering lets an unsourced business claim through to the customer.
 * When in doubt, lean toward detecting.
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

The lookbehind uses the Unicode classes `\p{L}\p{N}` instead of `\b`, because JavaScript's `\b` is ASCII-based and behaves incorrectly on accented letters.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/core/src/grounding/high-risk.test.ts`
Expected: PASS, all six tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/grounding
git commit -m "feat(core): add word-boundary high risk topic detection"
```

---

## Task 7: Grounding validator — mandatory test #1

**Files:**
- Create: `packages/core/src/grounding/validator.ts`
- Test: `packages/core/src/grounding/validator.test.ts`

**Interfaces:**
- Consumes: `detectHighRisk` from Task 6; `Segment`, `Candidate` from Task 5
- Produces: `validateGrounding(args: { answer: Answer; candidates: Candidate[]; highRiskTopics: string[] }): GroundingVerdict` where
  ```ts
  type GroundingVerdict =
    | { ok: true; citedChunkIds: string[] }
    | { ok: false
        violation: "missing_citation" | "unknown_citation"
                 | "unlabelled_high_risk" | "empty_answer"
        detail: string }
  ```

- [ ] **Step 1: Write a failing test — the case table from spec §9.1**

Create `packages/core/src/grounding/validator.test.ts`:

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
  it("rejects a business claim with no citation", () => {
    const v = run([{ kind: "business_claim", text: "Garansi 12 bulan.", citations: [] }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("missing_citation")
  })

  it("rejects a citation outside the candidate set", () => {
    const v = run([
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-99"] },
    ])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unknown_citation")
  })

  it("rejects a general segment that mentions a high-risk topic", () => {
    const v = run([{ kind: "general", text: "Harga kami paling murah kok." }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unlabelled_high_risk")
  })

  it("passes a business claim with a valid citation", () => {
    const v = run([
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual(["chunk-1"])
  })

  it("passes a greeting labelled general", () => {
    const v = run([{ kind: "general", text: "Halo! Tentu saya bantu." }])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual([])
  })

  it("collects unique citations across several segments", () => {
    const v = run([
      { kind: "general", text: "Halo!" },
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] },
      { kind: "business_claim", text: "Harganya Rp200.000.", citations: ["chunk-2", "chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    // `toSorted()`, not `sort()`: the latter mutates the array inside the
    // verdict, so the next assertion in the same test would inspect data
    // already shuffled by the previous assertion.
    if (v.ok) expect(v.citedChunkIds.toSorted()).toEqual(["chunk-1", "chunk-2"])
  })

  it("rejects an empty answer", () => {
    const v = run([])
    expect(v.ok).toBe(false)
    // The violation is checked too. Without this, an implementation that
    // rejects an empty answer with the wrong label — say, `missing_citation`
    // — would still pass, and a caller that branches on the rejection reason
    // would branch incorrectly.
    if (!v.ok) expect(v.violation).toBe("empty_answer")
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run packages/core/src/grounding/validator.test.ts`
Expected: FAIL — `Cannot find module './validator.js'`

- [ ] **Step 3: Minimal implementation**

Create `packages/core/src/grounding/validator.ts`:

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
    return { ok: false, violation: "empty_answer", detail: "no segments" }
  }

  const allowed = new Set(candidates.map((c) => c.id))
  const cited = new Set<string>()

  for (const seg of answer.segments) {
    if (seg.kind === "general") {
      // The model's own label isn't trusted for high-risk topics.
      const risky = detectHighRisk(seg.text, highRiskTopics)
      if (risky.length > 0) {
        return {
          ok: false,
          violation: "unlabelled_high_risk",
          detail: `general segment mentions: ${risky.join(", ")}`,
        }
      }
      continue
    }

    if (seg.citations.length === 0) {
      return {
        ok: false,
        violation: "missing_citation",
        detail: `business claim with no citation: ${seg.text.slice(0, 60)}`,
      }
    }

    for (const id of seg.citations) {
      // Validated against the candidate set, not against the database. The
      // model could make up an id that's real but was never retrieved.
      if (!allowed.has(id)) {
        return {
          ok: false,
          violation: "unknown_citation",
          detail: `citation outside the candidate set: ${id}`,
        }
      }
      cited.add(id)
    }
  }

  return { ok: true, citedChunkIds: [...cited] }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/core/src/grounding/validator.test.ts`
Expected: PASS, all seven tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/grounding/validator.ts packages/core/src/grounding/validator.test.ts
git commit -m "feat(core): add grounding validator with candidate-set citation check"
```

---

## Task 8: Prompt builder — mandatory test #3

**Files:**
- Create: `packages/core/src/prompt/builder.ts`
- Test: `packages/core/src/prompt/builder.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `TenantConfig` from Task 5; `PromptParts` from Task 5
- Produces:
  - `buildPrompt(args: { config: TenantConfig; history: {role:"user"|"assistant";content:string}[]; candidates: Candidate[]; question: string }): PromptParts`
  - `prefixOf(parts: PromptParts): string` — the part that must be byte-stable across questions

- [ ] **Step 1: Write a failing test**

Create `packages/core/src/prompt/builder.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildPrompt, prefixOf } from "./builder.js"
import type { Candidate, TenantConfig } from "../types.js"

const config: TenantConfig = {
  chatModel: "claude-opus-5",
  rewriteModel: "claude-opus-5",
  embeddingModel: "text-embedding-3-small",
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
  it("prefix is byte-identical for different questions", () => {
    const a = buildPrompt({ config, history, candidates: [c("k1", "Garansi 12 bulan")], question: "garansi?" })
    const b = buildPrompt({ config, history, candidates: [c("k2", "Harga 200rb")], question: "harga?" })
    expect(prefixOf(a)).toBe(prefixOf(b))
  })

  it("prefix changes when tenant configuration changes", () => {
    const a = buildPrompt({ config, history, candidates: [], question: "x" })
    const b = buildPrompt({
      config: { ...config, refusalText: "beda" },
      history, candidates: [], question: "x",
    })
    expect(prefixOf(a)).not.toBe(prefixOf(b))
  })

  it("retrieved context goes into the current turn, not system", () => {
    const p = buildPrompt({
      config, history,
      candidates: [c("k1", "Garansi resmi 12 bulan")],
      question: "garansi berapa lama?",
    })
    expect(p.system).not.toContain("Garansi resmi 12 bulan")
    expect(p.currentTurn).toContain("Garansi resmi 12 bulan")
  })

  it("includes chunk ids so the model can cite them", () => {
    const p = buildPrompt({ config, history, candidates: [c("k1", "isi")], question: "q" })
    expect(p.currentTurn).toContain("k1")
  })

  it("system prompt carries the refusal text and the tenant's high-risk topic list", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.system).toContain("Maaf, saya belum punya info itu.")
    // Asserting on the interpolated sentence, NOT just the word "garansi".
    // That word also appears in the static rules text, so `toContain("garansi")`
    // would still pass even if `config.highRiskTopics` were never rendered at
    // all — an assertion that proves nothing.
    expect(p.system).toContain("Topik yang selalu dianggap pernyataan bisnis: harga, garansi.")
  })

  it("history is passed through as-is, but not the caller's own array", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.history).toEqual(history)
    expect(p.history).not.toBe(history)
  })
})
```

The first test is **mandatory test #3** from spec §9.1. It catches a problem that, without a test, only ever shows up as an inflated bill with no explanation.

The last two assertions are deliberately stricter than they look like they need to be:

- **The topic list** is checked as the full interpolated sentence. Testing for a single word wouldn't distinguish "the tenant's topic list is rendered" from "that word happens to be in the static rules text".
- **`not.toBe(history)`** requires a shallow copy. `PromptParts.history` is promised to "only ever grow at the tail"; if the builder returned the caller's own array, one downstream `push` would mutate the caller's state too and break the prefix stability that is this task's entire reason for existing. The fix is one spread; the failure mode it prevents is silent and expensive.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run packages/core/src/prompt/builder.test.ts`
Expected: FAIL — `Cannot find module './builder.js'`

- [ ] **Step 3: Minimal implementation**

Create `packages/core/src/prompt/builder.ts`:

```ts
import type { PromptParts } from "../provider.js"
import type { Candidate, TenantConfig } from "../types.js"

/**
 * Assembles the prompt so the LLM cache actually hits. Render order is tools
 * → system → messages, and the cache is a prefix match, so what's stable must
 * come first and what's volatile must come last.
 *
 * Retrieved context MUST NOT go into `system` — it differs on every question
 * and would invalidate the cache on every request.
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

  // Shallow copy: the returned `history` must not share a reference with the
  // caller's own array, so a downstream mutation can't break prefix stability.
  return { system, history: [...history], currentTurn }
}

/**
 * The part of the prompt that must be byte-stable across questions within the
 * same conversation. Used by the cache regression test; don't put anything in
 * here that changes per request.
 */
export function prefixOf(parts: PromptParts): string {
  return JSON.stringify({ system: parts.system, history: parts.history })
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/core/src/prompt/builder.test.ts`
Expected: PASS, all six tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/prompt
git commit -m "feat(core): add cache-aware prompt builder with prefix stability test"
```

---

## Task 9: Hybrid search in the Store

**Files:**
- Create: `packages/db/src/store.ts`
- Test: `packages/db/src/store.test.ts`

**Interfaces:**
- Consumes: `withTenant` from Task 4; `interface Store` from Task 5
- Produces: `createStore(db: QuidDb): Store` — a `Store` implementation on top of Postgres

The `db` package implements `Store`, not `core`, because SQL is a database concern. `core` only knows the interface. `@quidchat/db` adds `@quidchat/core` as a dependency for types.

- [ ] **Step 1: Add the core dependency to db**

Modify `packages/db/package.json`, add to `dependencies`:

```json
"@quidchat/core": "workspace:*"
```

- [ ] **Step 2: Write a failing test**

Create `packages/db/src/store.test.ts`:

```ts
import { sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { freshPglite } from "./testing.js"
import { createStore } from "./store.js"
import {
  chunks, conversations, documents, knowledgeSources, tenants, tenantSettings,
} from "./schema.js"
import { withTenant } from "./tenant.js"

// The parameter is `offset`, not `seed` — `seed` is already used by the
// seeding function below, and shadowing it makes lint complain and a reader
// pause.
function fakeEmbedding(offset: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(offset + i) * 0.01)
}

/**
 * Sets up one complete tenant. `garansiText` is made different across tenants
 * so the isolation test can prove WHICH tenant's data is visible — not merely
 * that the result is empty.
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
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: garansiText,
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: "Pengiriman ke Jawa memakan waktu 2 hari.",
      embedding: fakeEmbedding(2), embeddingModel: "test" },
  ]).returning()
  const [cv] = await db.insert(conversations)
    .values({ tenantId: t!.id, channel: "widget", visitorId: "v1" }).returning()
  return { tenantId: t!.id, chunkId: rows[0]!.id, conversationId: cv!.id }
}

// A SINGLE database is shared by all tests in this file, via `beforeAll`.
// Two reasons:
//   1. `freshPglite()` builds a whole Postgres WASM binary and applies
//      migrations — about 7 seconds and a few hundred MB per instance. FOUR
//      instances in one file kills the vitest worker with "Worker exited
//      unexpectedly". That's measured, not a guess.
//   2. The tests below are safe to share: the first three only read, and the
//      last one only writes to `messages`, `message_citations`, and
//      `escalations` — tables no other test reads. If a future test reads
//      those written-to tables, test order starts to matter and this file
//      needs to be split, not just appended to.
const GARANSI_TOKO = "Garansi resmi berlaku 12 bulan sejak pembelian."
const GARANSI_WARUNG = "Garansi warung hanya 3 bulan."

describe("createStore", () => {
  let db: Awaited<ReturnType<typeof freshPglite>>
  let toko: Awaited<ReturnType<typeof seed>>
  let warung: Awaited<ReturnType<typeof seed>>

  beforeAll(async () => {
    db = await freshPglite()
    toko = await seed(db, "toko", GARANSI_TOKO)
    warung = await seed(db, "warung", GARANSI_WARUNG)
  })

  it("returns the tenant's configuration", async () => {
    const cfg = await createStore(db).getTenantConfig(toko.tenantId)
    expect(cfg.chatModel).toBe("claude-opus-5")
    expect(cfg.embeddingModel).toBe("text-embedding-3-small")
    expect(cfg.highRiskTopics).toContain("garansi")
  })

  it("finds a chunk via keyword", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi", embedding: fakeEmbedding(1), limit: 5,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toBe(GARANSI_TOKO)
    expect(hits[0]!.documentTitle).toBe("Kebijakan")
  })

  it("each tenant only sees its own chunks", async () => {
    // TWO real tenants, each with distinguishable chunks. Asking about a
    // single random uuid with no data only proves "empty", and that doesn't
    // distinguish "RLS is filtering" from "this tenant genuinely has nothing".
    // Here both tenants have content, so if RLS leaks, this test fails.
    const store = createStore(db)
    const args = { query: "garansi", embedding: fakeEmbedding(1), limit: 5 }

    const isiToko = (await store.searchChunks({ tenantId: toko.tenantId, ...args }))
      .map((h) => h.content)
    const isiWarung = (await store.searchChunks({ tenantId: warung.tenantId, ...args }))
      .map((h) => h.content)

    expect(isiToko).toContain(GARANSI_TOKO)
    expect(isiToko).not.toContain(GARANSI_WARUNG)
    expect(isiWarung).toContain(GARANSI_WARUNG)
    expect(isiWarung).not.toContain(GARANSI_TOKO)

    // A tenant that doesn't exist at all must still come back empty.
    const isiAsing = await store.searchChunks({
      tenantId: "00000000-0000-0000-0000-000000000000", ...args,
    })
    expect(isiAsing).toEqual([])
  })

  it("records an answer with its citations, and records an escalation", async () => {
    const store = createStore(db)
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

    expect(counts.messages).toBe(1)
    expect(counts.citations).toBe(1)
    expect(counts.escalations).toBe(1)
  })
})
```

That fourth test is **mandatory**, not just for completeness. `recordAnswer` writes to `message_citations`, which has a `tenant_id uuid NOT NULL` with no default — that column was added when the five foreign keys were turned into composite keys for tenant isolation. If the `INSERT` forgets to include `tenant_id`, the function fails **every single time it's called**, while the first three tests stay green because none of them call `recordAnswer`. The single most important path for the grounding audit trail is exactly the one most likely to slip through undetected.

Additional imports needed at the top of the test file: `beforeAll` from `vitest`, `sql` from `drizzle-orm`, `conversations` from `./schema.js`, and `withTenant` from `./tenant.js`.

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm install && pnpm vitest run packages/db/src/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 4: Minimal implementation**

Create `packages/db/src/store.ts`:

```ts
import type { Candidate, Segment, Store, TenantConfig } from "@quidchat/core"
import { sql } from "drizzle-orm"
import type { QuidDb } from "./client.js"
import { withTenant } from "./tenant.js"

/**
 * Normalizes the shape of `execute()` results, which DIFFERS between drivers:
 * the PGlite driver returns an object with `.rows`, while the postgres-js
 * driver returns the result of `client.unsafe()`, which is itself an Array
 * (with extra properties like `count` and `command`, but NO `.rows`).
 *
 * Without this normalization, accessing `.rows` directly would work across
 * the whole test suite — which uses PGlite — and then yield `undefined` in
 * tier 3, which uses postgres-js. A bug that survives every test and only
 * shows up in production.
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
          SELECT chat_model, rewrite_model, embedding_model, refusal_text, high_risk_topics
          FROM tenant_settings WHERE tenant_id = ${tenantId}
        `)
        const row = rowsOf(res)[0]
        if (!row) throw new Error(`tenant_settings not found: ${tenantId}`)
        return {
          chatModel: row.chat_model as string,
          rewriteModel: row.rewrite_model as string,
          embeddingModel: row.embedding_model as string,
          refusalText: row.refusal_text as string,
          highRiskTopics: row.high_risk_topics as string[],
        }
      })
    },

    async searchChunks({ tenantId, query, embedding, limit }): Promise<Candidate[]> {
      const vec = `[${embedding.join(",")}]`
      return withTenant(db, tenantId, async (tx) => {
        // Hybrid: the keyword score (ts_rank) and the semantic score
        // (1 - cosine distance) are summed with equal weight, then top-k
        // is taken.
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
          // `tenant_id` MUST be included. The column is `NOT NULL` with no
          // default, and this table's two composite foreign keys —
          // (tenant_id, message_id) and (tenant_id, chunk_id) — rely on it to
          // guarantee that a citation can never point at another tenant's
          // row. Omitting it makes every call to recordAnswer fail.
          await tx.execute(sql`
            INSERT INTO message_citations (tenant_id, message_id, chunk_id)
            VALUES (${tenantId}, ${messageId}, ${chunkId})
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

There is no `WHERE c.tenant_id = ...` in the search query — and that's **deliberate**. RLS does that job. Adding a manual filter would hide an RLS failure: if a policy ever breaks, the cross-tenant test would still pass because the application filter papers over it, and the leak would only surface in production.

- [ ] **Step 5: Export from index**

Modify `packages/db/src/index.ts`, add:

```ts
export * from "./store.js"
```

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run packages/db/src/store.test.ts`
Expected: PASS, all four tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src packages/db/package.json pnpm-lock.yaml
git commit -m "feat(db): implement Store with hybrid search relying on RLS for scoping"
```

---

## Task 10: Answer pipeline — mandatory test #2

**Files:**
- Create: `packages/core/src/testing/fakes.ts`
- Create: `packages/core/src/pipeline.ts`
- Test: `packages/core/src/pipeline.test.ts`

**Interfaces:**
- Consumes: `Store`, `Provider` from Task 5; `validateGrounding` from Task 7; `buildPrompt` from Task 8
- Produces:
  - `answer(args: { store: Store; provider: Provider; tenantId: string; conversationId: string; history: {role:"user"|"assistant";content:string}[]; question: string }): Promise<PipelineResult>`
  - `MemoryStore`, `FakeProvider` from `@quidchat/core/testing`

- [ ] **Step 0: Register the `./testing` entry point that Task 5 deliberately deferred**

Task 5 didn't declare this export because its file didn't exist yet and `tsdown` refuses input it can't find. Now that the file exists, register it at the same time.

Modify `packages/core/package.json`:

```json
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing/fakes.ts" },
  "scripts": {
    "build": "tsdown src/index.ts src/testing/fakes.ts --dts",
```

Run `pnpm build` after Step 1 is done to confirm the new input is found.

- [ ] **Step 1: Write the test fakes**

Create `packages/core/src/testing/fakes.ts`:

```ts
import type { Capabilities, CompleteResult, Provider, PromptParts } from "../provider.js"
import type { Store } from "../store.js"
import type { Answer, Candidate, EscalationReason, Segment, TenantConfig } from "../types.js"

export const DEFAULT_CONFIG: TenantConfig = {
  chatModel: "fake-model",
  rewriteModel: "fake-model",
  embeddingModel: "fake-embedding-model",
  refusalText: "Maaf, saya belum punya informasi itu.",
  highRiskTopics: ["harga", "diskon", "garansi", "refund", "stok", "legal"],
}

/**
 * Some methods below deliberately declare fewer parameters than `Store` does
 * — TypeScript allows it, and writing out unused parameters would only add
 * noise. The shape the pipeline actually calls stays the same.
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

/** A provider that returns answers from a prepared list, one per call. */
export class FakeProvider implements Provider {
  readonly id = "fake"
  /** Generate calls. Kept separate from `embedCalls` so a test can assert
   *  precisely which cost occurred and which didn't. */
  calls: PromptParts[] = []
  embedCalls: string[] = []

  constructor(private answers: Answer[]) {}

  async complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult> {
    this.calls.push(args.prompt)
    const next = this.answers[this.calls.length - 1] ?? this.answers.at(-1)
    if (!next) throw new Error("FakeProvider ran out of answers")
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

- [ ] **Step 2: Write a failing test**

Create `packages/core/src/pipeline.test.ts`:

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
  it("an empty knowledge base produces a refusal, not an answer", async () => {
    const store = new MemoryStore([])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 2 tahun.", citations: [] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("no_source")
    expect(store.recordedEscalations).toEqual(["no_source"])
    // Generate must NOT be called: with no candidates, anything the model
    // produces is guaranteed to fail validation, so calling it would only
    // waste money.
    expect(provider.calls).toHaveLength(0)
    // Embedding does happen — retrieval needs it to know the result is
    // empty in the first place. Stated explicitly so the boundary of this
    // claim is clear.
    expect(provider.embedCalls).toHaveLength(1)
  })

  it("answers with citations when a source exists", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    if (res.kind === "answered") expect(res.citedChunkIds).toEqual(["chunk-1"])
    expect(store.recordedAnswers).toHaveLength(1)
  })

  it("tries a second round when validation fails, then succeeds", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(provider.calls).toHaveLength(2)
    expect(res.kind).toBe("answered")
  })

  it("stops after two rounds and refuses", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "x", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    // A maximum of two calls — a third call must never happen.
    expect(provider.calls).toHaveLength(2)
    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("ungrounded")
  })

  it("propagates a getTenantConfig failure, does not turn it into a refusal", async () => {
    const store = new MemoryStore([])
    store.getTenantConfig = async () => {
      throw new Error("settings tidak terbaca")
    }
    const provider = new FakeProvider([])
    await expect(answer({ store, provider, ...ctx })).rejects.toThrow("settings tidak terbaca")
    // No escalation recorded: an infrastructure failure is not a business signal.
    expect(store.recordedEscalations).toEqual([])
  })

  it("propagates a searchChunks failure, does not turn it into a refusal", async () => {
    const store = new MemoryStore([candidate])
    store.searchChunks = async () => {
      throw new Error("database tidak terjangkau")
    }
    const provider = new FakeProvider([])
    await expect(answer({ store, provider, ...ctx })).rejects.toThrow("database tidak terjangkau")
    expect(store.recordedEscalations).toEqual([])
    // The embedding already happened before the store failed — stated so the boundary is clear.
    expect(provider.embedCalls).toHaveLength(1)
  })

  it("refuses with schema_invalid when the provider throws", async () => {
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

The first test is **mandatory test #2** from spec §9.1, and what it guards is the most dangerous regression in the whole pipeline: an implementation that "helpfully" answers from the model's general knowledge when the knowledge base has no answer.

The last two assertions draw the claim's boundary with precision, and that's deliberate. **Generate must not be called** — with no candidates, anything the model produces is guaranteed to fail grounding validation, so calling it would only waste money. **But embedding still happens**, because retrieval needs it precisely to find out the result is empty. Stating both makes this test prove exactly what it can actually prove, instead of implying an inaccurate "zero cost".

The cost of one embedding call only comes up while a tenant has no indexed content yet — a transient condition during setup. Avoiding it would require an extra check query on every single message, and that isn't worth it.

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm vitest run packages/core/src/pipeline.test.ts`
Expected: FAIL — `Cannot find module './pipeline.js'`

- [ ] **Step 4: Minimal implementation**

Create `packages/core/src/pipeline.ts`:

```ts
import { validateGrounding } from "./grounding/validator.js"
import { buildPrompt } from "./prompt/builder.js"
import type { Provider } from "./provider.js"
import type { Store } from "./store.js"
import type { EscalationReason, PipelineResult } from "./types.js"

const MAX_ROUNDS = 2
const CANDIDATE_LIMIT = 8

/**
 * Answers one customer question, or refuses.
 *
 * **Failure contract — deliberate and asymmetric.**
 *
 * PROVIDER failures are caught and turned into a recorded refusal. Reasoning:
 * a provider outage is per-message, the store is still alive so the
 * escalation is recorded correctly, and "we lost N conversations because the
 * provider was down" is genuinely information the business owner wants to see.
 *
 * STORE failures are NOT caught — they propagate to the caller. Three reasons:
 *   1. `EscalationReason` values are a BUSINESS SIGNAL that the tenant reviews
 *      to improve their knowledge base. An unreachable database is not that
 *      signal, and recording it would pollute the very metric that decisions
 *      get made from.
 *   2. `recordEscalation` itself goes through the store. If the store is down,
 *      recording the escalation fails too — swallowing the error would just
 *      turn one failure into two silent ones.
 *   3. The server layer must have a catch-all for bugs and OOM anyway, so
 *      that's the right place for this, not here.
 *
 * What the server layer must do: catch it, log it to operational logging (not
 * to `escalations`), reply to the visitor with a polite message, and return 503.
 */
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
    embedding = await provider.embed({ model: config.embeddingModel, text: question })
  } catch {
    return refuse("provider_unavailable")
  }

  const candidates = await store.searchChunks({
    tenantId, query: question, embedding, limit: CANDIDATE_LIMIT,
  })

  // With no candidates, there's nothing to cite. Refusing here saves one
  // LLM call that's guaranteed to fail validation anyway.
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

- [ ] **Step 5: Export the pipeline from index**

Modify `packages/core/src/index.ts`, add:

```ts
export * from "./grounding/high-risk.js"
export * from "./grounding/validator.js"
export * from "./pipeline.js"
export * from "./prompt/builder.js"
```

- [ ] **Step 6: Run the whole test suite**

Run: `pnpm test`
Expected: everything PASSes — **6 test files, 34 tests** green (`tenant` 3, `high-risk` 7, `validator` 7, `builder` 6, `store` 4, `pipeline` 7). These counts are tallied from the files as they now exist, not estimated; if your total differs, find out which file diverged before continuing.

- [ ] **Step 7: Verify the architectural boundary is enforced**

Run: `grep -rn "process.env\|require('http')\|from \"http\"\|from \"node:http\"" packages/core/src`
Expected: zero hits. `core` must not touch env or HTTP.

- [ ] **Step 8: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add answer pipeline with two-round retrieval limit"
```

---

## Definition of Done for Plan 1

Criteria from spec §11 met by this plan:

- **Tenant isolation** — Two tenants on one installation cannot see each other's
  data, proven by the RLS test (Task 4) and the two-tenant hybrid search test
  (Task 9).
- **§11.1 partially — THREE of EIGHT mandatory tests green:**

| # | Mandatory test | Status | Owner |
|---|---|---|---|
| 1 | Grounding validator, full case table | ✅ green | Task 7 (this plan) |
| 2 | Empty KB → refusal | ✅ green | Task 10 (this plan) |
| 3 | Prompt prefix stability | ✅ green | Task 8 (this plan) |
| 4 | Per-skill knowledge scoping | ⏳ pending | Plan 3 — needs `skills` + `skill_sources` tables |
| 5 | Handoff limit | ⏳ pending | Plan 3 — needs routing & handoff |
| 6 | `static` mode never calls the provider | ⏳ pending | Plan 4 — needs `answer_mode` |
| 7 | A draft never reaches the customer | ⏳ pending | Plan 4 — needs canned answers |
| 8 | Mode inheritance | ⏳ pending | Plan 4 — needs `answer_mode` at two levels |

**Bookkeeping note.** An earlier version of this plan wrote "three of **five**
mandatory tests" and named only #4 and #5 as remaining. Spec §11.1 is titled
"Eight mandatory tests since the first commit" — so three tests (#6 `static`
mode, #7 draft, #8 mode inheritance) weren't being counted at all. All three
concern features that were explicitly requested: QuidChat usable without AI,
and the promise that no AI-generated text ships without human approval. The
table above exists so that none of them can get lost between plans.

Final verification commands:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

All must be green before Plan 2 begins.
