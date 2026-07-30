-- Multi-skill routing: one skill = a persona + a subset of knowledge, selected by an
-- ordered list of routing rules (spec §5).

CREATE TABLE skills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  system_prompt text,
  enabled       boolean NOT NULL DEFAULT true,
  is_fallback   boolean NOT NULL DEFAULT false,
  -- NULL means "inherit from tenant_settings" — the same pattern already used by
  -- `skills.escalation_mode` in the design doc.
  answer_mode   text CHECK (answer_mode IN ('static', 'thrifty', 'full')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Knowledge scoping: which sources a skill may retrieve from. This is the SECOND
-- isolation boundary (spec §3.5) — RLS keeps tenants apart, this keeps skills apart
-- within one tenant. No own `id`/`tenant_id` role beyond the FK guard, same shape as
-- `message_citations` in 0001_init.sql: both composite FKs pin `tenant_id` so a row
-- can never link a skill and a source that belong to different tenants.
CREATE TABLE skill_sources (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  skill_id  uuid NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY (skill_id, source_id),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_sources(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE routing_rules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  skill_id  uuid NOT NULL,
  position  integer NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('keyword', 'semantic', 'llm', 'fallback')),
  pattern   text,
  enabled   boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE INDEX routing_rules_tenant_position_idx ON routing_rules (tenant_id, position);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skills', 'skill_sources', 'routing_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) '
      || 'WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- Tenant isolation guard, copied VERBATIM from the end of 0001_init.sql.
--
-- The guard in 0001 enumerates every RLS-relevant object AT THE TIME IT RAN — it ran
-- before `skills`, `skill_sources`, and `routing_rules` existed, so it never checked
-- them. Re-running the identical guard here, after those tables are created, is the
-- whole point: it re-enumerates the database as it stands NOW, so the new tables get
-- the exact same scrutiny the original ones got. If a future migration adds a table
-- and forgets RLS, this copy — or whichever migration runs last at the time — is what
-- catches it.
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
