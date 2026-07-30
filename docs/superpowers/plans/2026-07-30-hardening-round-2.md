# Hardening Round 2 Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Historical record.** This plan describes work that is complete. The code has moved on since
> it was written — most visibly, the codebase was translated to English after these tasks landed,
> so the Indonesian strings in the code samples below are what was built at the time, not what is
> in the repository now. Read it for the reasoning behind a decision; read the code for what the
> code does.


**Goal:** Close two tenant-isolation attacks that still succeed, one RRF parameter defect that subordinates the keyword path, and four claims that aren't yet pinned by a test.

**Architecture:** No new module. Fixes to the migration, `store.ts`, `tenant.ts`, and an expansion of the isolation tests to cover **writes**, not just reads.

## Why this plan exists

The first hardening round closed four unpinned properties. The final review found **two attacks that still succeeded**, both a one-line migration edit, both leaving 44/44 tests green:

| Attack | Measured consequence | Test that failed |
|---|---|---|
| `WITH CHECK (true)` on any policy | Cross-tenant write SUCCEEDED: a 500,000-cent `usage_events` row landed in another tenant's ledger, and a fabricated assistant message — "Promo price Rp1, contact wa.me/62800" — was planted in another business's transcript | **none** |
| `CREATE POLICY tenant_self ON tenants USING (true)` | `SELECT slug FROM tenants` returned the ENTIRE customer list | **none** |

**The root cause is one, and it's a design flaw.** All three of the first round's defence layers — guard1, guard2, and the behavioral test — selected tables by the **same** predicate: `information_schema.columns ... column_name = 'tenant_id'`. Layered defence means nothing when every layer rests on the same assumption. `tenants` keys on `id`, so it escaped all three at once. And not one of the three checked the **write** path.

## Global Constraints

Same as the previous plan, and still binding:

- Node `>=22.22.3`. TypeScript strict; `exactOptionalPropertyTypes: true`, so passing `undefined` to an optional property fails typecheck — use a conditional spread.
- ESM only; TypeScript source imports use the `.js` extension.
- **RLS is the only tenant-isolation mechanism.** No `WHERE tenant_id = ...` on scoped reads.
- `packages/core` is a pure library: empty `dependencies`, no env, no network.
- Every `execute()` goes through `rowsOf()`.
- **Code comments and commit messages are in ENGLISH.** Identifiers too.
  The ONLY thing that stays Indonesian is product copy: system prompts, refusal
  text, `high_risk_topics`, and fixture data — that's content read by Indonesian
  business customers, not code.
- Commits carry no attribution trailer of any kind. `git add` with explicit paths, **never** `git add -A`.
- `pnpm build` is part of verification on every task.

## Measured facts this plan rests on

Already verified on PGlite before this plan was written:

- `pg_policies.with_check` **is populated** for the 11 tables with `tenant_id`: `"(tenant_id = current_tenant_id())"`. For `tenants` it's `null` — Postgres derives it from `qual`. So the guard can and **must** check it, while also accepting `NULL` as valid.
- Of 12 tables, **`tenants` is the only one** with RLS but no `tenant_id` column. Its policy is `(id = current_tenant_id())`.
- The `WITH CHECK (true)` attack on `usage_events`: the original schema **rejects** cross-tenant writes; after the attack, it **succeeds**. `pg_policies.with_check` becomes `"true"` — detected.
- The `tenants` policy attack: before `["a"]`, after `["a","b"]`.
- RRF arithmetic, pool of 32: maximum single-list score is `1/(k+1)`, minimum dual-list score is `2/(k+32)`. For a rank-1 single-list chunk to be able to win, we need `k < pool − 2`. Since `poolSize = max(limit×4, 20)`, the pool is **at minimum 20**, so the requirement is `k < 18`. k=60 fails (0.01639 < 0.02174); k=20 fails for small pools; **k=10 satisfies the entire range** (0.09091 > 0.04762) while still preserving the property that presence in both lists is better (0.18182 > 0.09091).

---

### Task 1: A guard that covers writes and `tenants`

**Files:**
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`

Closes Critical 1, Critical 2, and Important 3.

- [ ] **Step 1: Replace both guard blocks with one guard that enumerates via RLS**

The key fix: **enumerate tables via `relrowsecurity`, not via the presence of a `tenant_id` column.** The expected expression is derived from the table's tenant key — `tenant_id` if the column exists, `id` if not — so `tenants` gets covered without being special-cased out.

In `packages/db/migrations/0001_init.sql`, replace the entire `DO $guard1$ ... END $guard1$;` and `DO $guard2$ ... END $guard2$;` with:

```sql
-- Tenant isolation guard. ONE block, enumerating via RLS.
--
-- The previous version selected tables via `column_name = 'tenant_id'`, and THAT
-- was the mistake: `tenants` keys on `id`, so it escaped EVERY defence layer at
-- once. Leaking its policy made `SELECT slug FROM tenants` return the entire
-- customer list, and not a single test failed.
--
-- The previous version also only checked `qual`, i.e. the READ path. `WITH CHECK
-- (true)` opens the WRITE path entirely: measured on PGlite, a usage_events row
-- worth 500,000 cents could be written to another tenant's ledger, and a fabricated
-- assistant message could be planted in another business's transcript. The guard
-- stayed silent, and 44 tests stayed green.
--
-- `with_check IS NULL` is valid and means Postgres derived it from `qual` — that's
-- what happens for `tenants`. What gets rejected is a `with_check` that EXISTS but
-- differs.
DO $guard_isolation$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s: %s', t.name, t.reason), ' | ') INTO bad
  FROM (
    SELECT c.relname AS name,
           -- This table's tenant key: `tenant_id` if it exists, otherwise `id`.
           -- `tenants` uses `id` because it IS the tenant itself.
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public' AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
           ) THEN 'tenant_id' ELSE 'id' END AS key,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
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
          WHERE p.schemaname = 'public' AND p.tablename = t.name
        ) THEN 'no policy'
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.name
            AND p.permissive = 'PERMISSIVE'
            AND coalesce(p.qual, '') <> h.expected
        ) THEN format('has a permissive policy with qual other than %s', h.expected)
        WHEN EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.name
            AND p.permissive = 'PERMISSIVE'
            AND p.with_check IS NOT NULL
            AND p.with_check <> h.expected
        ) THEN format('has a permissive policy with with_check other than %s', h.expected)
      END AS reason
  ) a
  WHERE a.reason IS NOT NULL;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tenant isolation incomplete -> %', bad;
  END IF;
END $guard_isolation$;
```

- [ ] **Step 2: Run the migration to make sure the guard passes on a healthy schema**

Run: `pnpm vitest run packages/db/src/tenant.test.ts`
Expected: PASS. If the guard rejects its own schema, there's a mistake in the expected expression — report the numbers, don't weaken the guard.

- [ ] **Step 3: Attack tests for all THREE holes, plus pinning the guard itself**

In `packages/db/src/isolation-guard.test.ts`, change `guardBlock` to use the new block name, then add the following tests to `describe("tenant isolation under attack")`:

```ts
  it("guard REJECTS a leaked with_check — the WRITE path", async () => {
    // The previous guard version only checked `qual`, i.e. the READ path. With
    // `WITH CHECK (true)` a tenant can WRITE rows owned by another tenant: measured,
    // one 500,000-cent usage_events row landed in someone else's ledger, and one
    // fabricated assistant message landed in another business's transcript.
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

  it("guard REJECTS a leaked tenants policy", async () => {
    // `tenants` keys on `id`, not `tenant_id`, so it escaped EVERY defence layer of
    // the previous version. Leaking it made the entire customer list readable by
    // any tenant.
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (true)`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`DROP POLICY tenant_self ON tenants`)
    await db.execute(sql`CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id())`)
  })

  it("guard REJECTS RLS being disabled", async () => {
    // Pins the part of the guard that checks enabled+forced. In the previous
    // version this lived in a separate block that no test invoked, so removing it
    // left 44/44 green.
    await db.execute(sql`ALTER TABLE chunks DISABLE ROW LEVEL SECURITY`)
    await expect(db.execute(sql.raw(guard))).rejects.toThrow()
    await db.execute(sql`ALTER TABLE chunks ENABLE ROW LEVEL SECURITY`)
    await db.execute(sql`ALTER TABLE chunks FORCE ROW LEVEL SECURITY`)
  })
```

- [ ] **Step 4: Behavioral test for the WRITE path, and include `tenants` in the read path**

In `describe("isolation of every table, measured behaviorally")`, change the enumeration from "tables with a `tenant_id` column" to "tables with RLS", and add a write test:

```ts
  /** Every table protected by RLS, with each one's tenant key. */
  async function tablesWithRls(): Promise<{ name: string; key: string }[]> {
    const r = await db.execute(sql`
      SELECT c.relname AS name,
             CASE WHEN EXISTS (
               SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public' AND col.table_name = c.relname
                 AND col.column_name = 'tenant_id'
             ) THEN 'tenant_id' ELSE 'id' END AS key
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname
    `)
    return rowsOf(r).map((x) => ({ name: x.name as string, key: x.key as string }))
  }

  it("every RLS-protected table shows only that tenant's own rows", async () => {
    const tables = await tablesWithRls()
    const leaked: string[] = []
    const empty: string[] = []
    for (const { name, key } of tables) {
      const owned = Number(
        rowsOf(
          await db.execute(
            sql.raw(`SELECT count(*)::int AS n FROM ${name} WHERE ${key} = '${idA}'`),
          ),
        )[0]!.n,
      )
      const visible = await withTenant(db, idA, async (tx) =>
        Number(rowsOf(await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${name}`)))[0]!.n),
      )
      if (owned === 0) empty.push(name)
      if (visible !== owned) leaked.push(`${name}: visible ${visible}, owned ${owned}`)
    }
    expect(leaked).toEqual([])
    expect(empty).toEqual([])
    // 12, not 11: `tenants` is now included. This number is what makes an
    // enumeration omission visible if some future table isn't RLS-protected.
    expect(tables).toHaveLength(12)
  })

  it("a tenant cannot WRITE rows owned by another tenant", async () => {
    // The write path. Perfect read isolation is worthless if a tenant can still
    // plant rows in another tenant's data — and that's the most damaging case of
    // all: a fake business claim in someone else's transcript, or a cost in
    // someone else's ledger.
    const failed: string[] = []
    const attempts: [string, ReturnType<typeof sql>][] = [
      ["usage_events", sql`
        INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, cost_cents)
        VALUES (${idB}, 'test', 1, 1, 500000)`],
      ["conversations", sql`
        INSERT INTO conversations (tenant_id, channel, visitor_id)
        VALUES (${idB}, 'widget', 'intruder')`],
      ["knowledge_sources", sql`
        INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
        VALUES (${idB}, 'text', 'intruder.txt', 'ready')`],
    ]
    for (const [name, statement] of attempts) {
      let rejected = false
      try {
        await withTenant(db, idA, async (tx) => {
          await tx.execute(statement)
        })
      } catch {
        rejected = true
      }
      if (!rejected) failed.push(name)
    }
    expect(failed).toEqual([])
  })
```

`idB` needs to be stored in that `describe`'s `beforeAll`, alongside `idA`.

- [ ] **Step 5: Verify**

```bash
pnpm test        # 44 + 6 new tests = 50
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 6: Prove each attack test can actually fail**

For each of the three attacks, temporarily remove the part of the guard that catches it and confirm the relevant test **fails**. Report what was observed. Don't skip this step: two review rounds found defects precisely this way, and not any other way.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0001_init.sql packages/db/src/isolation-guard.test.ts
git commit -m "fix(db): guard writes and the tenants table, not just tenant_id reads"
```

---

### Task 2: RRF that doesn't discard the keyword path

**Files:**
- Modify: `packages/db/src/store.ts`
- Modify: `packages/db/src/store.test.ts`

Closes Important 4 and Important 5.

- [ ] **Step 1: Lower the RRF constant from 60 to 10, with the reasoning**

In `packages/db/src/store.ts`, change the `60` in the `fused` CTE to `10`, and replace the comment above it:

```ts
          fused AS (
            -- RRF constant = 10, NOT 60 from the original paper. The reason is
            -- arithmetic, not taste.
            --
            -- The maximum score for a chunk appearing in only ONE list is 1/(k+1).
            -- The minimum score for a chunk appearing in BOTH lists is 2/(k+pool).
            -- With k=60 and pool=32: 0.01639 < 0.02174 — so a chunk present in both
            -- lists beats EVERY single-list chunk, no matter how good its match.
            --
            -- That's not merely suboptimal, it's structural exclusion: chunks with
            -- `embedding IS NULL` and chunks still using an old embedding model
            -- CANNOT enter the `sem` list, so they're permanently single-list.
            -- Measured: one answering chunk with no embedding, among 12 irrelevant
            -- embedded chunks, fell to rank 4; with >=8 dual-list chunks it falls
            -- out of the candidate window and the pipeline REFUSES even though the
            -- answer exists.
            --
            -- The requirement is k < pool − 2. Since `poolSize = max(limit*4, 20)`,
            -- the pool can be as small as 20, so k must be < 18. k=10 satisfies the
            -- entire range (0.09091 > 0.04762) and STILL makes presence in both
            -- lists an advantage (0.18182 > 0.09091) — just no longer an absolute one.
            SELECT id, SUM(1.0 / (10 + rnk)) AS score
            FROM (SELECT id, rnk FROM kw UNION ALL SELECT id, rnk FROM sem) u
            GROUP BY id
          )
```

- [ ] **Step 2: Fix the misleading name and comment on the `embedding_model` test**

The `embedding_model` filter exists on the `sem` CTE only, and **that's correct**: a chunk's text content doesn't depend on its embedding model, so the keyword path is right to cover every chunk. What's wrong is the test's name, which promises a blanket exclusion.

The old test passed only because the `OTHER_MODEL` fixture text happened not to contain the keyword. Change the fixture to contain it, then rename the test and update its assertions:

```ts
const OTHER_MODEL = "Old warranty: this was embedded with a different model."
```

```ts
  it("the vector path only considers the requested embedding model", async () => {
    // The `embedding_model` filter exists on the `sem` CTE ONLY, and that's correct:
    // a chunk's text content doesn't depend on its embedding model, so the keyword
    // path is right to cover every chunk. What's guarded is that the vector space
    // itself doesn't get mixed.
    //
    // The fixture deliberately CONTAINS the keyword "warranty". The previous version
    // didn't, and because of that the test passed without proving anything about the
    // filter.
    const viaKeyword = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "warranty",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 10,
    })
    // Via the keyword path it's ALLOWED to appear — the content is valid.
    expect(viaKeyword.map((h) => h.content)).toContain(OTHER_MODEL)

    // But via the vector path it must NOT: a query with no keyword match at all,
    // with an embedding identical to that chunk's, still must not return it.
    const viaVector = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "zzz not found anywhere",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 10,
    })
    expect(viaVector.map((h) => h.content)).not.toContain(OTHER_MODEL)
  })
```

- [ ] **Step 3: Test that a keyword-matched chunk WITHOUT an embedding is still findable**

This is a case no test covered before, and it's exactly the case most damaging to the user: a new document gets uploaded, its embedding isn't ready yet, a customer asks a question, and the bot answers "no information on that yet."

Add a chunk without an embedding to `seed`:

```ts
    { tenantId: t!.id, documentId: d!.id, ordinal: 3,
      content: NO_EMBEDDING, embedding: null, embeddingModel: "test" },
```

with the constant:

```ts
const NO_EMBEDDING = "Returns are accepted within seven days."
```

and the test:

```ts
  it("a keyword-matched chunk without an embedding is still findable", async () => {
    // Real-world case: a new document is uploaded, its embedding hasn't been
    // generated yet, and a customer asks. With an RRF constant of 60 this chunk
    // would never beat any chunk that has an embedding, no matter how good the
    // word match.
    const hits = await createStore(db).searchChunks({
      tenantId: shop.tenantId, query: "returns accepted",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 3,
    })
    expect(hits.map((h) => h.content)).toContain(NO_EMBEDDING)
  })
```

- [ ] **Step 4: Verify, then prove the new test can fail**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then restore the RRF constant to `60` and run `pnpm vitest run packages/db/src/store.test.ts`. The "keyword-matched chunk without an embedding" test **must fail**. Restore to `10` and confirm green. Report both.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/store.ts packages/db/src/store.test.ts
git commit -m "fix(db): stop the fusion constant from excluding keyword-only chunks"
```

---

### Task 3: Pin remaining claims, and make overstated ones honest

**Files:**
- Modify: `packages/db/src/tenant.ts`
- Modify: `packages/db/migrations/0001_init.sql`
- Modify: `packages/db/src/isolation-guard.test.ts`
- Modify: `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

Closes Minor 6, 7, and 8.

- [ ] **Step 1: Pin `hnsw.iterative_scan`**

Removing that line from `withTenant` currently leaves the whole suite green. Add to `isolation-guard.test.ts`:

```ts
  it("withTenant turns on iterative scan, because RLS filters after the index scan", async () => {
    // Without this, `ORDER BY embedding <=> v LIMIT k` can return fewer than k rows
    // for a small tenant inside a large table — losing recall with no error at all.
    const value = await withTenant(db, idA, async (tx) => {
      const r = await tx.execute(sql`SHOW hnsw.iterative_scan`)
      return rowsOf(r)[0]!["hnsw.iterative_scan"] as string
    })
    expect(value).toBe("strict_order")
  })
```

This test goes in the `describe` that has `idA`.

- [ ] **Step 2: Make a `GRANT` misconfiguration fatal, not a NOTICE**

If the migration role lacks ADMIN OPTION over `quidchat_app`, the migration currently reports success and then **every** request fails at `SET LOCAL ROLE`. Because tier 3 has no CI yet (§11.5), nothing will catch this before production.

Replace the `DO $grant$` block in `0001_init.sql` so it **proves** its outcome:

```sql
DO $grant$
BEGIN
  BEGIN
    EXECUTE format('GRANT quidchat_app TO %I', current_user);
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;  -- may already be a member via another path
  END;
  -- Proof, not hope: if this role can't switch to quidchat_app, EVERY request will
  -- fail inside withTenant() — much better to fail here.
  BEGIN
    EXECUTE 'SET LOCAL ROLE quidchat_app';
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'role % cannot SET ROLE quidchat_app. Run as superuser: GRANT quidchat_app TO %',
      current_user, current_user;
  END;
END $grant$;
```

- [ ] **Step 3: Make the overstated behavioral-test comment honest**

The comment in `isolation-guard.test.ts` claims that test catches "any policy defect, on any table, now or in the future." After Task 1 it covers read **and** write for every RLS-protected table, but it's still not a blanket guarantee. Replace the claim with an accurate statement: it measures the consequence on RLS-protected tables, for both read and write paths, and does not cover views, `SECURITY DEFINER` functions, or application code using a raw handle.

- [ ] **Step 4: Add required tests 4–8 to the §11.5 debt table**

Spec §11.1 is titled "Eight required tests since the first commit," but only 1, 2, and 3 exist, and §11.5 doesn't assign the rest. Add one row:

| Debt | Owner | Why not now |
|---|---|---|
| Required tests #4–#8 (per-skill scoping, handoff boundaries, `static` mode with no provider, drafts not shown live, mode inheritance) | Multi-skill plan (#4, #5) and answer-mode plan (#6, #7, #8) | All of them need the `skills`, `skill_sources`, `canned_answers` tables and an `answer_mode` column that don't exist yet. Recorded here so "eight required tests" isn't read as eight that already exist |

- [ ] **Step 5: Verify**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then temporarily remove the `SET LOCAL hnsw.iterative_scan` line from `withTenant` and confirm the new Step 1 test **fails**. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/db docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md
git commit -m "test(db): pin the iterative-scan setting and make a bad GRANT fatal"
```

---

## Definition of Done

- Both Critical attacks are rejected by the guard **and** by the behavioral test, each proven able to fail.
- Isolation of **writes** has a test; previously there was none at all.
- Table enumeration uses RLS, not column presence — so `tenants` no longer escapes, and any future table gets covered automatically.
- A keyword-matched chunk without an embedding is findable, with a test that fails if the RRF constant is reverted to 60.
- No claim in code or docs is stronger than what a test actually proves.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 warnings), `pnpm build` are all green.
