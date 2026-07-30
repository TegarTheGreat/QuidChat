# Foundation Hardening Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close six defects found in the final review of Plan 1, all of which passed the entire test suite because the tests never checked the property they claimed to.

**Architecture:** No new modules. This plan fixes five existing files in `packages/core` and `packages/db`, plus a migration, and adds tests that **fail when the property they cover breaks** — which the current tests don't do.

**Tech Stack:** Same as Plan 1. No new dependencies.

## Why this plan exists

The final review of Plan 1 found its defects by **breaking the code and watching the tests stay green**. Four properties the plan claimed were pinned turned out not to be:

| What was broken | Test that failed |
|---|---|
| Add `CREATE POLICY leak ON tenant_settings USING (true)` — tenant isolation completely gone | **zero** |
| Remove the `ts_rank` term from `ORDER BY` — keyword search dead | **zero** |
| Remove the cosine term from `ORDER BY` — semantic search dead | **zero** |
| Insert `new Date().toISOString()` into the system prompt — cache invalidated on every message | **zero** |

A green suite is not proof a property holds. This plan makes it proof.

## Global Constraints

Same as Plan 1, and still binding:

- Node `>=22.22.3`. TypeScript strict. ESM only; TypeScript source imports use the `.js` extension.
- Postgres is the only storage, one schema & migration set for every tier.
- **RLS is the ONLY tenant isolation mechanism.** Application code must never add `WHERE tenant_id = ...` to a scoped read.
- `packages/core` is a pure library: empty `dependencies`, no env access, no network.
- **Code comments and commit messages are in ENGLISH.** Identifiers too.
  The only things that stay in Indonesian are product copy: the system prompt, the refusal text,
  `high_risk_topics`, and fixture data — that's content read by Indonesian business customers,
  not code.
- Commits carry no attribution trailer of any kind.
- Each task declares only what it creates.
- **`pnpm build` is part of every task's verification.**

## File Structure

- `packages/db/migrations/0001_init.sql` — RLS guard tightened; `GRANT quidchat_app` to the login role.
- `packages/db/src/store.ts` — application filter removed; `searchChunks` becomes RRF.
- `packages/db/src/store.test.ts` — a test that pins both halves of retrieval.
- `packages/db/src/client.ts` — wrong tier-3 comment corrected.
- `packages/core/src/store.ts` — `searchChunks` gets `embeddingModel`; `recordUserTurn` added.
- `packages/core/src/pipeline.ts` — a repair round that's genuinely different; full transcript.
- `packages/core/src/prompt/builder.ts` — verdict feedback parameter.
- `packages/core/src/prompt/builder.test.ts` — mandatory test #3 with a moving clock.
- `packages/core/src/testing/fakes.ts` — `MemoryStore` follows the new interface.

---

### Task 1: RLS as the only guard, and a guard that proves it

**Files:**
- Modify: `packages/db/src/store.ts` (remove `WHERE tenant_id` in `getTenantConfig`)
- Modify: `packages/db/migrations/0001_init.sql` (guard tightened)
- Modify: `packages/db/src/client.ts` (wrong comment)

**Interfaces:**
- Consumes: `withTenant` from Plan 1
- Produces: no new API

Finding closed: `getTenantConfig` carried a `WHERE tenant_id = $1` — the only application-level filter in the package, and exactly what the Global Constraints forbid. Proven by review: adding a leaky policy on `tenant_settings` left 7/7 tests green, because the application filter still returned the correct row even though isolation had already collapsed.

- [ ] **Step 1: Remove the application filter**

In `packages/db/src/store.ts`, inside `getTenantConfig`, change the query to:

```ts
        const res = await tx.execute(sql`
          SELECT chat_model, rewrite_model, embedding_model, refusal_text, high_risk_topics
          FROM tenant_settings
        `)
```

No `WHERE`. Already verified in PGlite: inside `withTenant`, this query returns **exactly one** row, belonging to the currently active tenant. If the policy is broken, it returns more than one and the test fails — that's the point.

Add this comment right above the query:

```ts
        // NO `WHERE tenant_id` here — and that's required. RLS does the scoping. An
        // application filter here would return the correct row even when the policy has
        // already collapsed, so an isolation leak would pass the entire test suite and
        // only show up in production. Proven: a leaky policy + this filter = 7/7 tests
        // still green.
```

- [ ] **Step 2: Tighten the migration guard**

The existing guard only checks that a policy *exists*, not that it actually scopes. Already verified that `pg_policies.qual` contains the expression text — for the current schema: `"(tenant_id = current_tenant_id())"`.

In `packages/db/migrations/0001_init.sql`, replace the entire guard block at the end of the file with:

```sql
-- Guard part 1: every table with a `tenant_id` must have RLS both enabled AND forced,
-- and must have at least one policy.
DO $guard1$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s)', t.nama, t.alasan), ', ') INTO bad
  FROM (
    SELECT c.relname AS nama,
           CASE
             WHEN NOT (c.relrowsecurity AND c.relforcerowsecurity)
               THEN 'RLS not enabled or not forced'
             WHEN NOT EXISTS (
               SELECT 1 FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname
             ) THEN 'no policy'
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
    RAISE EXCEPTION 'RLS incomplete: %', bad;
  END IF;
END $guard1$;

-- Guard part 2: EVERY permissive policy on a table with a `tenant_id` must have an
-- expression that is EXACTLY `(tenant_id = current_tenant_id())`. Not "contains", not
-- "mentions" — exactly that.
--
-- TWO earlier versions of this guard lost, and both lost by trying to infer MEANING from
-- TEXT:
--   1. "there exists one policy that mentions current_tenant_id()" -> defeated by adding
--      `USING (true)` ALONGSIDE the correct policy. Postgres ORs permissive policies
--      together, so isolation collapses while the correct policy is still present and the
--      existence check is still satisfied. Measured: 1 row -> 2 rows.
--   2. "every permissive policy CONTAINS current_tenant_id()" -> defeated by
--      `USING (current_tenant_id() IS NOT NULL)`. It mentions the function without
--      restricting a single row. Measured: `conversations` leaked 1 -> 2 rows, returning
--      another tenant's visitor_id, and the guard stayed SILENT.
--
-- Substring inspection can NEVER prove a policy CONSTRAINS. Because all 11 tables with a
-- tenant_id in this schema do use one identical expression (verified 11/11), that
-- uniformity is made into the rule.
DO $guard2$
DECLARE bad text;
BEGIN
  SELECT string_agg(
           format('%s.%s = %s', p.tablename, p.policyname, coalesce(p.qual, 'NULL')),
           ' | '
         ) INTO bad
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.permissive = 'PERMISSIVE'
    AND EXISTS (
      SELECT 1 FROM information_schema.columns col
      WHERE col.table_schema = 'public' AND col.table_name = p.tablename
        AND col.column_name = 'tenant_id'
    )
    AND coalesce(p.qual, '') <> '(tenant_id = current_tenant_id())';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'a policy on a tenant_id table must be EXACTLY (tenant_id = current_tenant_id()); found: %',
      bad;
  END IF;
END $guard2$;
```

Already verified: this passes on the current schema, and **rejects both attacks** above.

**Text analysis only guards FORM.** That's why there's a second layer that guards CONSEQUENCE:
`packages/db/src/isolation-guard.test.ts` fills ALL 11 tables with a `tenant_id` for two
tenants, then for every table asserts that the row count one tenant sees equals the count
it actually owns. That test catches both attacks **without needing to anticipate them**,
and it also requires that no table is empty — on the first attempt 8 of 11 tables were
empty, so its "passing" would not have proven anything.

- [ ] **Step 2b: Make `getTenantConfig` reject an ambiguous read**

Removing the `WHERE` is correct, but it leaves a gap: if the policy leaks, the query
returns several rows and the code silently takes the first one — which could belong to
another tenant. Because every tenant's default settings are identical on a fresh
installation, a test that checks `chatModel` wouldn't notice.

In `packages/db/src/store.ts`, inside `getTenantConfig`:

```ts
        const rows = rowsOf(res)
        if (rows.length === 0) throw new Error(`tenant_settings not found: ${tenantId}`)
        // More than one row means RLS is currently NOT isolating — under a correct
        // policy, a `SELECT` with no `WHERE` inside withTenant() can only ever see one row.
        if (rows.length > 1) {
          throw new Error(
            `tenant isolation failed: tenant_settings returned ${rows.length} rows for one tenant`,
          )
        }
        const row = rows[0]!
```

This is an **invariant assertion**, not an application filter: it doesn't narrow the query,
it refuses to proceed when the query result already proves RLS is broken.

- [ ] **Step 3: Make `quidchat_app` actually usable at tier 3**

`CREATE ROLE quidchat_app NOLOGIN` with no password and no `GRANT quidchat_app TO <login role>` makes the documented tier-3 connection **impossible**: connecting as `quidchat_app` fails (NOLOGIN), and connecting as any other role fails at `SET LOCAL ROLE` with "permission denied to set role".

In `0001_init.sql`, right after the `GRANT ... ON ALL TABLES ... TO quidchat_app` block, add:

```sql
-- The role the application connects as MUST be a member of `quidchat_app`, otherwise
-- `SET LOCAL ROLE quidchat_app` in withTenant() fails with "permission denied to set
-- role". `quidchat_app` itself is deliberately NOLOGIN: it isn't a role you connect as,
-- it's a role you drop DOWN INTO after connecting. This line grants that membership to
-- whatever role is currently running the migration, which at tier 1 and tier 2 is
-- indeed the application role.
DO $grant$
BEGIN
  EXECUTE format('GRANT quidchat_app TO %I', current_user);
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- already a member
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'cannot GRANT quidchat_app TO %; do it manually as superuser', current_user;
END $grant$;
```

- [ ] **Step 4: Correct the wrong tier-3 comment in `client.ts`**

The current comment claims that a superuser `url` reproduces the PGlite leak. That's **wrong**
for the `withTenant` path, and the existing test proves the opposite: PGlite connects as the
superuser `postgres`, but inside `withTenant` the same query sees 1 row, not 2, because
`SET LOCAL ROLE` drops `current_user` down so RLS applies. The leak is **only** in the raw handle.

Replace that comment with:

```ts
/**
 * `url` for tier 3. The role used to connect MUST be a member of `quidchat_app` — the
 * migration tries to grant that automatically; if your environment doesn't allow it,
 * run `GRANT quidchat_app TO <role>` as superuser at deploy time.
 *
 * Connecting as a superuser does NOT defeat isolation on the `withTenant` path:
 * `SET LOCAL ROLE quidchat_app` drops `current_user` down, so RLS still applies —
 * proven by the isolation test, which runs on PGlite as the superuser `postgres`.
 * The ONLY thing that genuinely bypasses RLS is the raw handle (`db` directly, without
 * `withTenant`), regardless of role. That's intentional, for migrations and onboarding
 * new tenants.
 */
```

- [ ] **Step 5: Verify**

```bash
pnpm test        # 34 tests still green
pnpm typecheck
pnpm lint        # still 0 warnings
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "fix(db): let RLS be the only tenant filter, and prove policies scope"
```

---

### Task 2: A hybrid search that's actually hybrid (RRF)

**Files:**
- Modify: `packages/core/src/store.ts` (`searchChunks` gets `embeddingModel`)
- Modify: `packages/db/src/store.ts` (RRF)
- Modify: `packages/core/src/pipeline.ts` (pass through `config.embeddingModel`)
- Modify: `packages/core/src/testing/fakes.ts` (`MemoryStore` follows the interface)
- Modify: `packages/db/src/store.test.ts` (a test that pins both halves)

**Interfaces:**
- Produces: `searchChunks(args: { tenantId: string; query: string; embedding: number[]; embeddingModel: string; limit: number }): Promise<Candidate[]>`

Two findings at once. **First**, the two scores' scales aren't comparable: `ts_rank` for a
single-term match is **0.0608**, while `1 - cosine` ranges over **[-1, 1]** — a span of 2.0.
Measured in PGlite: for the query `"garansi"`, the chunk that **contains** the word scored
0.3615 total and **lost** to a chunk that didn't contain it at all but whose embedding was
identical (1.0). Keyword ranking contributed ~3% of the scale; effectively dead. That
defeats the entire reason hybrid retrieval exists: exact terms, SKUs, product names.

**Second**, `chunks.embedding_model` is stored precisely so retrieval can keep using the old
model during a re-index (spec §3.3), but nothing reads it and the interface gives the caller
no way to name a model. The result: when a tenant switches embedding models with the same
dimensionality, `chunks` ends up holding two different vector spaces, ranking gets scrambled,
and the assistant cites a chunk that's wrong but looks plausible — exactly the failure spec
§3.3 describes: *"retrieval doesn't error — it returns results that are irrelevant but look
plausible."*

- [ ] **Step 1: Add `embeddingModel` to the `Store` interface**

In `packages/core/src/store.ts`:

```ts
  /** Hybrid search: RRF over the top-k of the keyword path and the vector path. Scoped to the tenant by RLS. */
  searchChunks(args: {
    tenantId: string
    query: string
    embedding: number[]
    /**
     * The model used to produce `embedding`. Chunks embedded with a DIFFERENT model are
     * excluded: two vector spaces in one search doesn't error, it just returns results
     * that are irrelevant but look plausible. The column exists on
     * `chunks.embedding_model` exactly for this (spec §3.3).
     */
    embeddingModel: string
    limit: number
  }): Promise<Candidate[]>
```

- [ ] **Step 2: Write a failing test — pinning BOTH halves**

In `packages/db/src/store.test.ts`, change `seed` to accept a chunk that's distinguishable per
path, then add the following tests. New constants at the top of the file:

```ts
const KW_ONLY = "Garansi produk ini berlaku dua belas bulan."
const SEM_ONLY = "Pengiriman ke Jawa memakan waktu dua hari kerja."
const MODEL_LAIN = "Ini di-embed dengan model lain dan tidak boleh muncul."
```

Inside `seed`, replace the two chunks with three:

```ts
  const rows = await db.insert(chunks).values([
    // Contains the keyword, embedding FAR from the test query.
    { tenantId: t!.id, documentId: d!.id, ordinal: 0,
      content: garansiText,
      embedding: fakeEmbedding(50), embeddingModel: "test" },
    // Does NOT contain the keyword, embedding IDENTICAL to the test query.
    { tenantId: t!.id, documentId: d!.id, ordinal: 1,
      content: SEM_ONLY,
      embedding: fakeEmbedding(1), embeddingModel: "test" },
    // Identical embedding BUT a different model -> must be filtered out.
    { tenantId: t!.id, documentId: d!.id, ordinal: 2,
      content: MODEL_LAIN,
      embedding: fakeEmbedding(1), embeddingModel: "model-lain" },
  ]).returning()
```

And add these three tests:

```ts
  it("the keyword path is alive: the keyword chunk wins even with a far embedding", async () => {
    // The query embedding MUST be far from every chunk, so the only reason a chunk can
    // win is the keyword path. If the ts_rank term is removed from the implementation,
    // this test fails — which the earlier version did not.
    //
    // Offset 600 is NOT arbitrary. `fakeEmbedding` uses `Math.sin(offset + i)`, which is
    // PERIODIC, so an offset that looks "far" can actually be close. Measured cosine
    // distances:
    //     offset 999 -> 0.0284 from the keyword chunk   (practically IDENTICAL)
    //     offset 600 -> 1.9756 from the keyword chunk, 1.5027 from the semantic chunk
    // The first version of this test used 999 and therefore PASSED even with the keyword
    // path removed: the chunk won via the semantic path instead. A test that couldn't fail.
    // If this offset is ever changed, RECOMPUTE the cosine distances first.
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(600), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(GARANSI_TOKO)
  })

  it("the semantic path is alive: with no keyword match, the nearest one is still found", async () => {
    // A query that matches no keyword at all. If the cosine term is removed, the keyword
    // path returns nothing and this test fails.
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "zzz tidak ada di mana pun",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 1,
    })
    expect(hits[0]!.content).toBe(SEM_ONLY)
  })

  it("a chunk from a different embedding model is excluded", async () => {
    const hits = await createStore(db).searchChunks({
      tenantId: toko.tenantId, query: "garansi",
      embedding: fakeEmbedding(1), embeddingModel: "test", limit: 10,
    })
    expect(hits.map((h) => h.content)).not.toContain(MODEL_LAIN)
  })
```

Also update the existing `"finds a chunk via keyword"` test to pass `embeddingModel: "test"`.

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm vitest run packages/db/src/store.test.ts`
Expected: FAIL — the `embeddingModel` argument isn't accepted yet.

- [ ] **Step 4: Replace `searchChunks` with RRF**

In `packages/db/src/store.ts`:

```ts
    async searchChunks({ tenantId, query, embedding, embeddingModel, limit }): Promise<Candidate[]> {
      const vec = `[${embedding.join(",")}]`
      // The per-path pool is made larger than `limit` so fusion has material to work
      // with; 20 as a floor so a small limit doesn't starve the candidate pool.
      const poolSize = Math.max(limit * 4, 20)
      return withTenant(db, tenantId, async (tx) => {
        // Reciprocal Rank Fusion. Both paths are taken top-k INDEPENDENTLY, then merged
        // by RANK, not by raw score.
        //
        // Summing raw scores doesn't work: ts_rank for a single-term match is around
        // 0.06 while (1 - cosine) ranges over [-1, 1]. Measured in PGlite, the chunk that
        // CONTAINS the keyword lost to a chunk that didn't contain it at all. RRF
        // ignores scale — only order — so both paths actually carry weight.
        //
        // Important side effect: the `sem` CTE uses the form
        // `ORDER BY embedding <=> vec LIMIT k`, the only form that can use the HNSW
        // index. The old version, which ordered by the sum of two scores, could never
        // use it.
        const res = await tx.execute(sql`
          WITH kw AS (
            SELECT c.id,
                   row_number() OVER (
                     ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', ${query})) DESC, c.id
                   ) AS rnk
            FROM chunks c
            WHERE c.tsv @@ plainto_tsquery('simple', ${query})
            ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', ${query})) DESC, c.id
            LIMIT ${poolSize}
          ),
          sem AS (
            SELECT c.id,
                   row_number() OVER (ORDER BY c.embedding <=> ${vec}::vector, c.id) AS rnk
            FROM chunks c
            WHERE c.embedding IS NOT NULL
              AND c.embedding_model = ${embeddingModel}
            ORDER BY c.embedding <=> ${vec}::vector, c.id
            LIMIT ${poolSize}
          ),
          fused AS (
            SELECT id, SUM(1.0 / (60 + rnk)) AS score
            FROM (SELECT id, rnk FROM kw UNION ALL SELECT id, rnk FROM sem) u
            GROUP BY id
          )
          SELECT c.id, c.content, d.title, f.score
          FROM fused f
          JOIN chunks c ON c.id = f.id
          JOIN documents d ON d.id = c.document_id
          ORDER BY f.score DESC, c.id
          LIMIT ${limit}
        `)
        return rowsOf(res).map((r) => ({
          id: r.id as string,
          content: r.content as string,
          documentTitle: r.title as string,
        }))
      })
    },
```

The constant 60 is the value from the original RRF paper. `c.id` as a tie-breaker in every
`ORDER BY` makes the result deterministic; without it, equally-scored chunks could swap
order between calls.

Still **no** `WHERE c.tenant_id` in either CTE — RLS does the scoping.

- [ ] **Step 5: Pass `embeddingModel` through from the pipeline**

In `packages/core/src/pipeline.ts`:

```ts
  const candidates = await store.searchChunks({
    tenantId, query: question, embedding,
    embeddingModel: config.embeddingModel,
    limit: CANDIDATE_LIMIT,
  })
```

The model used to embed the question and the model used to filter chunks are now
guaranteed to be the same, because both are `config.embeddingModel`.

- [ ] **Step 6: Adjust `MemoryStore`**

`MemoryStore.searchChunks` ignores its arguments, so no signature change is needed — but
run `pnpm typecheck` to confirm.

- [ ] **Step 7: Verify**

```bash
pnpm test        # 43 tests (store 4 -> 7)
pnpm typecheck
pnpm lint
pnpm build
```

- [ ] **Step 8: Commit**

```bash
git add packages/core packages/db
git commit -m "fix(db): fuse hybrid search by rank so keyword retrieval actually counts"
```

---

### Task 3: Mandatory test #3 with a moving clock

**Files:**
- Modify: `packages/core/src/prompt/builder.test.ts`

Spec §11.1 states very specifically why this test exists: *"a single `new Date()` in the
system prompt invalidates the cache on every question, with no error and no log."* Review
proved the existing test **doesn't** catch it: inserting `new Date().toISOString()` into
the system prompt left all six tests green, because two calls to `buildPrompt` landed in
the same millisecond.

- [ ] **Step 1: Add a test with a fake clock**

In `packages/core/src/prompt/builder.test.ts`, add `vi` to the vitest import, then add this test:

```ts
  it("prefix stays identical even as time passes between two calls", () => {
    // This is exactly the regression spec §11.1 cites as the reason this test exists: a
    // single `new Date()` in the system prompt invalidates the cache on every message,
    // with no error and no log. A test with no fake clock does NOT catch it — two calls
    // happen to land in the same millisecond, so the timestamps happen to match and the
    // prefix still matches.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const a = buildPrompt({ config, history, candidates: [c("k1", "isi")], question: "q1" })
      vi.advanceTimersByTime(60 * 60 * 1000) // one hour
      const b = buildPrompt({ config, history, candidates: [c("k2", "lain")], question: "q2" })
      expect(prefixOf(a)).toBe(prefixOf(b))
    } finally {
      vi.useRealTimers()
    }
  })
```

- [ ] **Step 2: Prove this test actually catches the regression**

Temporarily insert this line into the `system` array in `packages/core/src/prompt/builder.ts`:

```ts
    `Waktu sekarang: ${new Date().toISOString()}`,
```

Run: `pnpm vitest run packages/core/src/prompt/builder.test.ts`
Expected: **the new test FAILS**, the other tests pass. If the new test passes, it isn't measuring anything — report it, don't proceed.

Then **remove that line again** and rerun; everything must be green.

- [ ] **Step 3: Verify**

```bash
pnpm test        # 38 tests (builder 6 -> 7)
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/prompt
git commit -m "test(core): advance the clock so the cache test catches its own regression"
```

---

### Task 4: A second round that's actually different

**Files:**
- Modify: `packages/core/src/prompt/builder.ts` (feedback parameter)
- Modify: `packages/core/src/pipeline.ts` (pass through the verdict)
- Modify: `packages/core/src/pipeline.test.ts` (a test proving the prompt differs)

Spec §4 step 6 asks for a **repair round**. What exists now is a byte-identical resample:
every input to `buildPrompt` is loop-invariant, so round 2 sends the exact same
`PromptParts`. With a temperature-0 provider — a reasonable default for structured output
— round 2 returns the same ungrounded answer, so every ungrounded turn pays twice for a
guaranteed duplicate.

A rewrite-query repair round needs a text-completion method on `Provider` that doesn't
exist yet and belongs to a future provider-layer plan. What **can** be done now without
changing `Provider`: feed the validator's rejection reason back to the model. That makes
round 2 different, gives the model actionable information, and uses the existing `complete`.

- [ ] **Step 1: Accept feedback in `buildPrompt`**

In `packages/core/src/prompt/builder.ts`, add an optional field to its arguments and use it in `currentTurn`:

```ts
export function buildPrompt(args: {
  config: TenantConfig
  history: { role: "user" | "assistant"; content: string }[]
  candidates: Candidate[]
  question: string
  /**
   * Why the previous answer was rejected, if this is a repair round. Placed in
   * `currentTurn`, NOT in `system` — it changes per attempt, and putting it in the
   * stable part would invalidate the cache prefix on every message.
   */
  feedback?: string
}): PromptParts {
  const { config, history, candidates, question, feedback } = args
```

Then in assembling `currentTurn`:

```ts
  const currentTurn = [
    "<konteks>",
    contextBlock,
    "</konteks>",
    "",
    ...(feedback
      ? [
          "<perbaikan>",
          `Jawaban sebelumnya DITOLAK: ${feedback}`,
          "Perbaiki dengan menyitasi id dari <konteks> di atas untuk setiap klaim bisnis,",
          "atau sampaikan teks penolakan bila konteksnya memang tidak memuat jawabannya.",
          "</perbaikan>",
          "",
        ]
      : []),
    `Pertanyaan pelanggan: ${question}`,
  ].join("\n")
```

`prefixOf` doesn't change: the feedback only touches `currentTurn`, so prefix stability
stays intact — and mandatory test #3 keeps guarding it.

- [ ] **Step 2: Pass the verdict through in the pipeline**

In `packages/core/src/pipeline.ts`, replace the loop body:

```ts
  let feedback: string | undefined
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prompt = buildPrompt({ config, history, candidates, question, feedback })

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
      // ... unchanged ...
    }

    // The rejection reason carries over to the next round. Without this, round 2 sends
    // an IDENTICAL prompt, and a temperature-0 model returns an identical answer — paying
    // twice for a guaranteed duplicate.
    feedback = `${verdict.violation} — ${verdict.detail}`
  }
```

- [ ] **Step 3: Test that the second round's prompt is DIFFERENT**

In `packages/core/src/pipeline.test.ts`, add to the `"tries a second round when validation fails, then succeeds"` test:

```ts
    expect(provider.calls).toHaveLength(2)
    // The second round must carry a DIFFERENT prompt. This is the assertion that failed
    // on the earlier version, when round 2 was a byte-identical resample.
    expect(provider.calls[1]!.currentTurn).not.toBe(provider.calls[0]!.currentTurn)
    expect(provider.calls[1]!.currentTurn).toContain("missing_citation")
    // But the PREFIX must stay the same, or the cache is invalidated.
    expect(provider.calls[1]!.system).toBe(provider.calls[0]!.system)
    expect(res.kind).toBe("answered")
```

- [ ] **Step 4: Verify**

```bash
pnpm test        # 38 tests, same count (an assertion was added, not a test)
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "fix(core): feed the rejection reason into the repair round"
```

---

### Task 5: A complete transcript

**Files:**
- Modify: `packages/core/src/store.ts` (`recordUserTurn`)
- Modify: `packages/db/src/store.ts` (its implementation)
- Modify: `packages/core/src/pipeline.ts` (record the user turn + the reply, including refusals)
- Modify: `packages/core/src/testing/fakes.ts` (`MemoryStore`)
- Modify: `packages/core/src/pipeline.test.ts`, `packages/db/src/store.test.ts`

A refusal leaves no assistant message in the transcript, and there is no way to record the
user's turn at all. The result: `messages` only ever holds successful answers — a tenant
opening a conversation to see **why** the bot escalated (the stated purpose of the
escalation record) sees a question with no reply, and so does a widget replaying history.

- [ ] **Step 1: Add `recordUserTurn` to the interface**

In `packages/core/src/store.ts`:

```ts
  /** Records the visitor's message. Called before retrieval so the transcript stays
   *  complete even when the turn ends in a refusal. */
  recordUserTurn(args: {
    tenantId: string
    conversationId: string
    text: string
  }): Promise<void>
```

- [ ] **Step 2: Implement it in `packages/db/src/store.ts`**

```ts
    async recordUserTurn({ tenantId, conversationId, text }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO messages (tenant_id, conversation_id, role, content)
          VALUES (${tenantId}, ${conversationId}, 'user', ${text})
        `)
      })
    },
```

- [ ] **Step 3: Make `refuse` write its reply too**

In `packages/core/src/pipeline.ts`, record the user turn first, and make `refuse` save the
refusal text as an assistant message:

**Note on types.** This repo sets `exactOptionalPropertyTypes: true` in
`tsconfig.base.json`, so passing `feedback: undefined` to an optional property FAILS
typecheck. The correct form is a conditional spread: `...(feedback ? { feedback } : {})`.
The same rule applies to any optional property in this plan.

```ts
  const { store, provider, tenantId, conversationId, history, question } = args
  const config = await store.getTenantConfig(tenantId)

  await store.recordUserTurn({ tenantId, conversationId, text: question })

  const refuse = async (reason: EscalationReason): Promise<PipelineResult> => {
    await store.recordEscalation({ tenantId, conversationId, reason })
    // The refusal text also goes into the transcript. Without this, a tenant opening a
    // conversation to find out why the bot escalated only sees a question with no reply,
    // and a widget that replays history loses half the conversation.
    await store.recordAnswer({
      tenantId, conversationId,
      segments: [{ kind: "general", text: config.refusalText }],
      citedChunkIds: [],
    })
    return { kind: "refused", text: config.refusalText, reason }
  }
```

- [ ] **Step 4: Adjust `MemoryStore`**

In `packages/core/src/testing/fakes.ts`, add:

```ts
  recordedUserTurns: string[] = []

  async recordUserTurn(args: { text: string }): Promise<void> {
    this.recordedUserTurns.push(args.text)
  }
```

- [ ] **Step 5: Adjust the affected tests, then add new ones**

The `"an empty knowledge base produces a refusal, not an answer"` test now also records one
answer, so add:

```ts
    expect(store.recordedUserTurns).toEqual(["garansi berapa lama?"])
    // A refusal also leaves a reply in the transcript.
    expect(store.recordedAnswers).toHaveLength(1)
    expect(store.recordedAnswers[0]!.citedChunkIds).toEqual([])
```

In `packages/db/src/store.test.ts`, the fourth test must now count 1 user message + 1
assistant message. Update `expect(counts.messages)` to `2` after calling `recordUserTurn`
once in that test.

- [ ] **Step 6: Verify**

```bash
pnpm test
pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/db
git commit -m "feat(core): keep refusals in the conversation transcript"
```

---

### Task 6: Document corrections and assigning what's left

**Files:**
- Modify: `docs/superpowers/plans/2026-07-29-foundation-and-core-pipeline.md`
- Modify: `docs/superpowers/specs/2026-07-29-quidchat-kernel-design.md`

- [ ] **Step 1: Correct the "three tiers" claim in Plan 1**

Plan 1's architecture line mentions three tiers; `createDb` supports two (`pglite` and
`postgres`). Change it to two, and note that the `embedded` tier is a process-lifecycle
concern that belongs to the `quidchat serve` plan, reusing `kind: "postgres"` once that
process is alive.

- [ ] **Step 2: Add an acknowledged-debt block to the spec**

Add to the spec, below §11.4:

```markdown
### 11.5 Acknowledged debt, with an owner

| Debt | Owner | Why not now |
|---|---|---|
| Typed errors on `Provider` so 429/503/timeout aren't recorded as `schema_invalid` | Provider-layer plan | Needs a `Provider` interface change; right now every throw from `complete()` becomes `schema_invalid` and pollutes the business signal |
| A rewrite-query repair round using `rewriteModel` | Provider-layer plan | Needs a text-completion method; verdict feedback is used in the meantime |
| A CI job against real Postgres (tier 3) | Server plan | The sandbox blocks `spawn initdb`; `rowsOf` and the `client.unsafe` branch have never been executed on the most important tier |
| The `embedded-postgres` tier | `quidchat serve` plan | A process-lifecycle concern; reuses `kind: "postgres"` |
| A CI query: `messages` LEFT JOIN `message_citations` to find answers with no citation | Ingestion/eval plan | The last remaining path to the failure this product defines as its opposite: an answer made only of `general` segments that supposedly slipped past the `high_risk_topics` list |
| New tenant onboarding MUST use the raw handle | Admin/signup plan | The `tenant_self` policy's `USING` also applies as `WITH CHECK`, so an `INSERT` of a new tenant as `quidchat_app` always fails: the newly generated `id` can never equal `current_tenant_id()` |
| `answer()` opens 3–4 separate transactions per turn | Cost-accounting plan | Retrieval and recording aren't atomic with each other; nothing is broken yet, but it needs to be known before budget accounting lands |
```

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: correct the tier count and record acknowledged debt with owners"
```

---

## Definition of Done

- Six final-review findings closed or explicitly assigned.
- Four properties that were previously unpinned now fail when broken — and Task 3 Step 2 requires proving it, not just claiming it.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 warnings), `pnpm build` all green.
- Zero `WHERE tenant_id` application filters anywhere in `packages/db`.
