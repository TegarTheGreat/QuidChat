-- Answer modes: `static` (canned text, zero LLM cost at runtime), `thrifty`
-- (local embedding, still no generation), `full` (today's pipeline, unchanged).
-- See docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md §6.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE tenant_settings
  ADD COLUMN answer_mode text NOT NULL DEFAULT 'full'
    CHECK (answer_mode IN ('static', 'thrifty', 'full'));

-- `canned_answers` is `static` mode's only data source. Nothing here reaches a
-- customer until a human sets `status = 'approved'` — an AI-proposed row
-- starts at `draft` and is invisible to matching until then. That's what makes
-- `static` mode trustworthy for price/warranty questions: every live answer
-- was read by a person before it could ever be sent.
CREATE TABLE canned_answers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question   text NOT NULL,
  answer     text NOT NULL,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Mirrors `chunks.tsv` above: a generated column, deliberately kept out of
  -- the Drizzle model (see the note on `chunks` in schema.ts) because it's
  -- only ever read through raw SQL in `matchCannedAnswer`.
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('simple', question)) STORED,
  UNIQUE (tenant_id, id)
);

CREATE INDEX canned_answers_tenant_idx         ON canned_answers (tenant_id);
CREATE INDEX canned_answers_tsv_idx            ON canned_answers USING GIN (tsv);
-- Trigram index so a near-miss (typo, reordered words) still matches when
-- full-text search finds nothing.
CREATE INDEX canned_answers_question_trgm_idx  ON canned_answers USING GIN (question gin_trgm_ops);

ALTER TABLE canned_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE canned_answers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canned_answers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Tenant isolation guard, copied verbatim from the end of 0001_init.sql so
-- `canned_answers` is proven by the same check every other tenant-scoped table
-- already passes, rather than trusted on inspection alone.
--
-- An earlier version selected tables via `column_name = 'tenant_id'`, and THAT
-- was the mistake: `tenants` keys on `id`, so it escaped every layer of
-- defence at once. Leaking its policy made `SELECT slug FROM tenants` return
-- the entire customer list, and not a single test failed.
--
-- An earlier version also only inspected `qual`, which is the READ path.
-- `WITH CHECK (true)` opened the WRITE path completely: measured against
-- PGlite, a usage_events row worth 500,000 cents could be written to another
-- tenant's ledger, and a fabricated assistant message could be planted in
-- another business's transcript. The guard stayed silent, and 44 tests
-- remained green.
--
-- `with_check IS NULL` is legitimate and means Postgres derives it from `qual`
-- — that's what happens for `tenants`. What is rejected is a `with_check` that
-- IS present but differs.
DO $guard_isolation$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s: %s', t.name, a.reason), ' | ') INTO bad
  FROM (
    SELECT c.relname AS name,
           n.nspname AS schema,
           -- This table's tenant key: `tenant_id` if it exists, otherwise `id`.
           -- `tenants` uses `id` because it IS the tenant itself.
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = n.nspname AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
           ) THEN 'tenant_id' ELSE 'id' END AS key,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%'
      AND n.nspname NOT LIKE 'pg_toast_temp%'
      AND c.relkind IN ('r', 'p')   -- 'p' = partitioned table; its parent is NOT 'r'
      -- Infrastructure tables are named with a leading underscore and hold no tenant
      -- data. The migration ledger is one: it must exist before the first migration
      -- runs, so it cannot be created by a migration that this guard then inspects.
      --
      -- This is a stated rule rather than a list of exempt names, and the rule cannot be
      -- abused to hide tenant data: `isolation-guard.test.ts` asserts that no table
      -- whose name starts with an underscore has a `tenant_id` column, so smuggling
      -- tenant-scoped data behind the prefix fails a test.
      AND c.relname NOT LIKE '\_%'
  ) t
  CROSS JOIN LATERAL (
    SELECT format('(%s = current_tenant_id())', t.key) AS expected
  ) h
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN NOT (t.rls_enabled AND t.rls_forced) THEN 'RLS not enabled or not forced'
        WHEN NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = t.schema AND p.tablename = t.name
        ) THEN 'no policy'
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = t.schema AND p.tablename = t.name
            AND p.permissive = 'PERMISSIVE'
            AND p.qual IS NOT NULL AND p.qual <> h.expected
        ) THEN format('has a permissive policy with qual other than %s', h.expected)
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = t.schema AND p.tablename = t.name
            AND p.permissive = 'PERMISSIVE'
            AND p.with_check IS NOT NULL AND p.with_check <> h.expected
        ) THEN format('has a permissive policy with with_check other than %s', h.expected)
        WHEN NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = t.schema AND p.tablename = t.name
            AND p.permissive = 'PERMISSIVE'
            AND (p.qual = h.expected OR p.with_check = h.expected)
        ) THEN 'no permissive policy scopes to the tenant'
      END AS reason
  ) a
  WHERE a.reason IS NOT NULL;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tenant isolation incomplete -> %', bad;
  END IF;
END $guard_isolation$;

-- Views and matviews do NOT have RLS of their own. A view runs with its OWNER's
-- privileges unless created `WITH (security_invoker = true)`, and that default is
-- OFF. Measured: a plain view over `conversations` made tenant A see tenant B's
-- messages.
--
-- Matviews are worse: `security_invoker` does not apply to them at all, so the only
-- safe posture is withholding SELECT from the application role.
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
      'view without security_invoker=true but readable by quidchat_app -> %; the caller''s RLS does NOT apply there',
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
      'materialized view readable by quidchat_app -> %; matviews do not support security_invoker, so its SELECT privilege must be revoked',
      bad;
  END IF;
END $guard_matview$;

-- SECURITY DEFINER functions run as their creator, so they bypass RLS. And `EXECUTE`
-- is granted to PUBLIC by DEFAULT — without any explicit GRANT, the application role
-- can already call one. Measured: a dashboard function returned both tenants' message
-- counts.
--
-- `current_tenant_id()` itself is exempted: it genuinely needs to exist and it is
-- INVOKER.
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
      'SECURITY DEFINER function executable by quidchat_app -> %; such functions bypass RLS',
      bad;
  END IF;
END $guard_secdef$;
