# Hardening Round 3 Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close isolation holes that will open the moment the next features add views, functions, another schema, or partitioned tables — and pin four claims that currently can be broken with no test failing.

**Architecture:** No new module. Expand the migration guard so it's no longer looking only at plain tables in the `public` schema, revoke privileges the application role shouldn't have, and strengthen tests that have been measuring the wrong thing.

## Why this plan exists

The adversarial gate returned a verdict of **conditional GO**: today's schema can't be breached, read or write. But five attacks succeeded against object types the next three features are certain to introduce. All of them were verified by adding a plausible `0002_provider_layer.sql` to a copy of the repo, then running the real suite — **50/50 stayed green every time**.

The root cause is one: the guard **and** the behavioral test both filter on `nspname = 'public' AND relkind = 'r'`.

| Object | Why it leaks | Measured |
|---|---|---|
| `VIEW` | `security_invoker` is **off** by default, so a view runs as its owner and the caller's RLS doesn't apply | withTenant(A) saw "TENANT A SECRET PRICE" **and** "TENANT B SECRET PRICE" |
| `MATERIALIZED VIEW` | Same, and `security_invoker` **cannot** fix it | leaked |
| `SECURITY DEFINER` function | `EXECUTE` is granted to `PUBLIC` by default | message count of the other tenant |
| Table in a non-`public` schema | Outside the enumeration | read **and** write across tenants |
| Partitioned table | The parent has `relkind='p'` | cross-tenant read via the parent |

And one amplifier that makes everything more dangerous: `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES` already grants full DML on **every future table**. So the guard is the only barrier between a new table and a read+write leak.

## Global Constraints

Same as the previous round, and still binding:

- Node `>=22.22.3`. TypeScript strict; `exactOptionalPropertyTypes: true`.
- ESM only; TypeScript source imports use the `.js` extension.
- **RLS is the only tenant-isolation mechanism.** No `WHERE tenant_id = ...` on scoped reads.
- Every `execute()` goes through `rowsOf()`.
- **Code comments and commit messages are in ENGLISH.** Identifiers too.
  The ONLY thing that stays Indonesian is product copy: system prompts, refusal
  text, `high_risk_topics`, and fixture data — that's content read by Indonesian
  business customers, not code.
- Commits carry no attribution trailer of any kind. `git add` with explicit paths, **never** `git add -A`.
- `pnpm build` is part of verification on every task.
- Any fix that claims to pin down a property **must** be proven by breaking the code and watching the relevant test fail. The two previous rounds found five defects this way, and none any other way.

---

### Task 1: A guard that sees everything that can leak

**Files:**
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`

- [ ] **Step 1: Expand the guard's enumeration from one object type to everything relevant**

Replace the `WHERE n.nspname = 'public' AND c.relkind = 'r'` part in `DO $guard_isolation$` with an enumeration that covers plain tables **and** partitioned tables, across **every** application schema:

```sql
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%'
      AND n.nspname NOT LIKE 'pg_toast_temp%'
      AND c.relkind IN ('r', 'p')   -- 'p' = partitioned table; its parent is NOT 'r'
```

`relkind IN ('r','p')` closes the partitioned-table attack: the parent is `'p'`, so the old guard never saw it while `CREATE POLICY ... USING (true)` there went unnoticed.

Removing the `'public'` pin closes the other-schema attack. Measured: `analytics.leads` could be read **and written** across tenants, and `UPDATE ... WHERE tenant_id = B` correctly landed on tenant B's row.

- [ ] **Step 2: Add three new guards for object types RLS doesn't protect**

After `DO $guard_isolation$`, add:

```sql
-- Views and matviews do NOT have RLS of their own. A view runs with its OWNER's
-- privileges unless created `WITH (security_invoker = true)`, and the default is
-- OFF. Measured: a simple view over `conversations` let tenant A see tenant B's
-- messages.
--
-- Matviews are worse: `security_invoker` doesn't apply to them at all, so the only
-- safe approach is to never grant SELECT to the application role.
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
      'materialized view readable by quidchat_app -> %; matviews do not support security_invoker, so SELECT must be revoked',
      bad;
  END IF;
END $guard_matview$;

-- SECURITY DEFINER functions run as their creator, so they bypass RLS. And
-- `EXECUTE` is granted to PUBLIC by DEFAULT — with no GRANT at all, the
-- application role can already call them. Measured: one dashboard function
-- returned the message count of both tenants.
--
-- `current_tenant_id()` itself is excluded: it needs to exist and it IS INVOKER.
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
      'SECURITY DEFINER function callable by quidchat_app -> %; functions like that bypass RLS',
      bad;
  END IF;
END $guard_secdef$;
```

- [ ] **Step 3: Fix the guard's rejection of legitimate per-command policies**

The guard currently rejects `CREATE POLICY ... FOR INSERT WITH CHECK (tenant_id = current_tenant_id())`, because a `FOR INSERT` policy has `qual` set to `NULL` and the check compares `coalesce(p.qual,'')` against the expected value. That would block legitimate per-command policy work later.

Change both checks so `NULL` is treated as "doesn't apply to this command," not as a violation:

```sql
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
```

That last branch matters: without it, a policy whose `qual` and `with_check` are both `NULL` would pass all three checks. The guard must require **at least one** policy that genuinely scopes to the tenant, not merely confirm that none is wrong.

`pg_policies` already includes `schemaname`, so cross-schema enumeration needs to match against it — change every `p.schemaname = 'public'` to `p.schemaname = t.schema`, and add `n.nspname AS schema` to the table-selection subquery.

- [ ] **Step 4: A test that pins the guard's ENUMERATION, not just its contents**

This is the most important part of this task. The gate found that rewriting the guard as a hardcoded list of 12 tables left all eight attack tests **still green**, because they all targeted a listed table. The enumeration itself wasn't pinned by anything.

Add to `packages/db/src/isolation-guard.test.ts`, in `describe("tenant isolation under attack")`:

```ts
  it("guard REJECTS a new table with no RLS", async () => {
    // Pins the guard's ENUMERATION, not its contents. If the guard were rewritten
    // as a hardcoded list of table names, the other eight attack tests would STAY
    // green — they all target listed tables. This is the one that catches it, and
    // it also closes the most likely real-world scenario: the next migration adds
    // a table and forgets RLS.
    await db.execute(sql`CREATE TABLE forgot_rls (tenant_id uuid NOT NULL, content text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE forgot_rls`)
  })

  it("guard REJECTS a table in another schema with no RLS", async () => {
    // Attack measured to leak BOTH READ AND WRITE: `analytics.leads`.
    await db.execute(sql`CREATE SCHEMA analytics`)
    await db.execute(sql`CREATE TABLE analytics.leads (tenant_id uuid NOT NULL, notes text)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP SCHEMA analytics CASCADE`)
  })

  it("guard REJECTS a partitioned table with no RLS", async () => {
    // A partitioned table's parent has relkind 'p', not 'r', so the old guard never
    // saw it and `USING (true)` there went unnoticed.
    await db.execute(sql`
      CREATE TABLE audit_log (tenant_id uuid NOT NULL, occurred_at timestamptz NOT NULL)
      PARTITION BY RANGE (occurred_at)
    `)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP TABLE audit_log`)
  })

  it("guard REJECTS a view readable by the app role without security_invoker", async () => {
    const guardView = guardBlock("guard_view")
    await db.execute(sql`CREATE VIEW summary AS SELECT tenant_id, visitor_id FROM conversations`)
    await db.execute(sql`GRANT SELECT ON summary TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).rejects.toThrow()
    // And with security_invoker on, the guard passes.
    await db.execute(sql`DROP VIEW summary`)
    await db.execute(sql`
      CREATE VIEW summary WITH (security_invoker = true) AS
      SELECT tenant_id, visitor_id FROM conversations
    `)
    await db.execute(sql`GRANT SELECT ON summary TO quidchat_app`)
    await expect(db.execute(sql.raw(guardView))).resolves.toBeDefined()
    await db.execute(sql`DROP VIEW summary`)
  })

  it("guard REJECTS a SECURITY DEFINER function callable by the app role", async () => {
    const guardSecdef = guardBlock("guard_secdef")
    await db.execute(sql`
      CREATE FUNCTION leak() RETURNS bigint LANGUAGE sql SECURITY DEFINER
      AS 'SELECT count(*) FROM conversations'
    `)
    await expect(db.execute(sql.raw(guardSecdef))).rejects.toThrow()
    await db.execute(sql`DROP FUNCTION leak()`)
  })
```

- [ ] **Step 5: Verify and prove each test can fail**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

For **each** of the five new tests, temporarily remove the part of the guard that catches it and confirm that test — and only that test — fails. Report all five.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0001_init.sql packages/db/src/isolation-guard.test.ts
git commit -m "fix(db): guard views, functions, other schemas and partitioned tables"
```

---

### Task 2: Tests that measure the right thing

**Files:**
- Modify: `packages/db/src/isolation-guard.test.ts`
- Modify: `packages/db/src/tenant.test.ts`

- [ ] **Step 1: Flip the inverted table-count assertion**

`expect(tables).toHaveLength(12)` is **inverted**: adding a table that's correctly protected turns it red (measured at 13), while adding a table that's **not** protected leaves it green — because a table with no RLS never enters the enumeration. The assertion punishes the correct case and lets the wrong one through.

Replace it with a lower bound plus a comparison against reality:

```ts
    // A LOWER bound, not an exact count. Adding a correctly RLS-protected table
    // should NOT turn this test red; what should turn it red is a table that is
    // NOT protected — and that's precisely what's excluded from this enumeration,
    // so it's caught instead by the "guard REJECTS a new table with no RLS" test
    // in the same file.
    expect(tables.length).toBeGreaterThanOrEqual(12)
    // Every table with a tenant_id column MUST have RLS. This is what catches a new
    // table that forgot to be protected, from the behavior side rather than the
    // guard side.
    const withoutRls = rowsOf(
      await db.execute(sql`
        SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT c.relrowsecurity
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
          )
      `),
    ).map((x) => x.name as string)
    expect(withoutRls).toEqual([])
```

- [ ] **Step 2: Compare IDENTITY, not just count**

The read test currently compares row counts. A tenant that sees exactly as many rows as another tenant owns would pass. For tables with a `tenant_id` column, compare the set of visible `tenant_id` values instead:

```ts
      // In addition to the count, check that every visible tenant_id genuinely
      // belongs to this tenant. Comparing counts alone would pass a case where one
      // tenant sees exactly as many rows as another tenant owns.
      if (key === "tenant_id") {
        const foreign = await withTenant(db, idA, async (tx) =>
          rowsOf(
            await tx.execute(
              sql.raw(`SELECT DISTINCT tenant_id::text AS t FROM ${name}`),
            ),
          ).map((x) => x.t as string),
        )
        for (const t of foreign) if (t !== idA) leaked.push(`${name}: saw tenant_id ${t}`)
      }
```

- [ ] **Step 3: Pin `set_config(..., true)` — this is a production risk, not cosmetic**

Changing `true` to `false` in `packages/db/src/tenant.ts` leaves **50/50 green**. The production consequence is serious: the tenant context becomes session-scoped and **survives past the transaction** on a pooled `postgres-js` connection, so the next request on that same connection inherits the previous request's tenant.

Add to `packages/db/src/tenant.test.ts`:

```ts
it("tenant context does not survive after the transaction ends", async () => {
  const db = await freshPglite()
  const r = await db.execute(sql`INSERT INTO tenants (slug, name) VALUES ('a','A') RETURNING id`)
  const id = rowsOf(r)[0]!.id as string

  await withTenant(db, id, async (tx) => {
    const inside = rowsOf(await tx.execute(sql`SELECT current_tenant_id() AS t`))[0]!.t
    expect(inside).toBe(id)
  })

  // OUTSIDE the transaction the context must already be gone. If `set_config` is
  // called with `false`, the value is session-scoped and survives — and on a pooled
  // connection that means the next request inherits the previous request's tenant.
  const outside = rowsOf(await db.execute(sql`SELECT current_tenant_id() AS t`))[0]!.t
  expect(outside).toBeNull()
})
```

- [ ] **Step 4: Widen write coverage: UPDATE, DELETE, and moving tenant_id**

Write coverage currently is three `INSERT`s on three tables. There's no `UPDATE`, `DELETE`, or `UPDATE ... SET tenant_id = <other>` — the most direct way to move a row to another tenant. Add to the write test:

```ts
    // UPDATE on a row owned by another tenant must have NO effect (RLS hides it, so
    // zero rows affected), and moving one's OWN row to another tenant must be
    // REJECTED by with_check.
    const result = await withTenant(db, idA, async (tx) => {
      const upd = await tx.execute(sql.raw(
        `UPDATE conversations SET visitor_id = 'stolen' WHERE tenant_id = '${idB}'`,
      ))
      return rowsOf(upd).length
    })
    expect(result).toBe(0)

    let moveRejected = false
    try {
      await withTenant(db, idA, async (tx) => {
        await tx.execute(sql.raw(`UPDATE conversations SET tenant_id = '${idB}'`))
      })
    } catch {
      moveRejected = true
    }
    expect(moveRejected).toBe(true)
```

- [ ] **Step 5: Verify and prove**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then: change `set_config(..., true)` to `false` and confirm the Step 3 test **fails**; restore. Report it.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/isolation-guard.test.ts packages/db/src/tenant.test.ts
git commit -m "test(db): measure identity and write paths, and pin the transaction-local context"
```

---

### Task 3: Revoke privileges the application role shouldn't have

**Files:**
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`
- Modify: `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

- [ ] **Step 1: Revoke DML on `tenants` from the application role**

`GRANT ... ON ALL TABLES` gives the application role `DELETE` and `UPDATE` on `tenants`. Measured: `DELETE FROM tenants` inside `withTenant` **succeeds** and cascades away all of that tenant's own data. `UPDATE tenants SET slug = ...` also succeeds, and because the unique index on `slug` is **global**, it becomes a cross-tenant existence oracle: a slug already used by another tenant produces a duplicate-key error, a free slug produces success.

Onboarding a new tenant already has to use a raw handle — the `tenant_self` policy makes `INSERT` as `quidchat_app` always fail — so the application role has no need for write access there at all.

After the existing `GRANT` block, add:

```sql
-- The application role may only READ its own row in `tenants`, nothing more.
-- The `GRANT ... ON ALL TABLES` above also gives it UPDATE and DELETE, and both are
-- dangerous: `DELETE FROM tenants` inside withTenant succeeds and cascades away all
-- of that tenant's own data; `UPDATE tenants SET slug=...` succeeds, and because the
-- slug unique index is GLOBAL it becomes a cross-tenant existence oracle — a slug
-- owned by another tenant produces a duplicate-key error, a free slug produces success.
--
-- Onboarding already uses a raw handle, because the `tenant_self` policy makes an
-- INSERT as quidchat_app impossible anyway. So nothing is lost.
REVOKE INSERT, UPDATE, DELETE ON tenants FROM quidchat_app;
```

- [ ] **Step 2: Test that the privilege is genuinely revoked**

```ts
  it("app role cannot delete or modify rows in tenants", async () => {
    // DELETE used to succeed and cascade away all of that tenant's own data.
    // UPDATE on slug used to succeed, and the GLOBAL unique index on slug turned it
    // into a cross-tenant existence oracle.
    for (const statement of [
      sql`DELETE FROM tenants`,
      sql`UPDATE tenants SET slug = 'anything'`,
    ]) {
      let rejected = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(statement)
        })
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
    }
  })
```

- [ ] **Step 3: Record the remaining dangers in §11.5, with owners**

Add these rows to the spec's debt table:

| Debt | Owner | Why not now |
|---|---|---|
| Looking up `admin_sessions` by session id needs a raw-handle query **before** the tenant is known, and no isolation layer covers it | Admin panel plan | The admin panel's first isolation danger. Needs a narrow, audited dedicated path, not a general-purpose raw handle |
| `withTenant` is not a boundary against the application code itself: `RESET ROLE` inside the callback restores superuser | Server plan | Code discipline, not a schema hole. Needs a lint rule or review, not a schema change |
| The migration refuses to apply if the deployment's `search_path` doesn't include `public` | Server plan | The guard fails CLOSED, so it's safe — but the message needs to explain why |
| The unique index on `tenants.slug` is global, so it remains an existence oracle for anyone who can INSERT | Signup plan | After Step 1 the application role can't INSERT; the signup flow has to handle it itself |

- [ ] **Step 4: Verify**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then remove the `REVOKE` line and confirm the Step 2 test **fails**; restore.

- [ ] **Step 5: Commit**

```bash
git add packages/db docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md
git commit -m "fix(db): revoke write access to tenants from the application role"
```

---

## Definition of Done

- All five gate attacks are rejected by the guard, each with a test proven able to fail.
- The guard's own enumeration is pinned, so rewriting it as a hardcoded list fails a test.
- `set_config(..., true)` is pinned — changing it to `false` fails a test.
- The table-count assertion is no longer inverted.
- Isolation is measured via identity, not just count, and covers UPDATE, DELETE, and moving `tenant_id`.
- The application role has no write access to `tenants`.
- Dangers this plan doesn't close are recorded in §11.5 with their respective owners.
