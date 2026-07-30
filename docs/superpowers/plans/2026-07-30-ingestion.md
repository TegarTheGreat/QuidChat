# Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a business put its own content into QuidChat — pasted text, an uploaded file, or a crawled URL — chunked, embedded, and retrievable, so the assistant has something to answer from.

**Architecture:** New package `packages/ingest`. Pure functions for chunking, a small orchestrator that writes through `Store`, and a crawler kept deliberately narrow. Embedding comes from the `Provider` already in place.

**Tech Stack:** Node 22 built-ins. `fetch` for crawling. No new runtime dependency for text and HTML; anything richer is out of scope for v1 and recorded as debt.

## Why this plan exists

The pipeline refuses when it has no source, and right now every tenant has no source. A business cannot add content by any means except writing SQL by hand. This is the plan that makes the product usable by its actual owner rather than by its developer.

There is also a correctness reason to build it carefully. Retrieval quality is set here, not in the search query: chunks that split a sentence in half, or that carry no context about which document they came from, produce answers that cite a source which does not actually support the claim. The grounding validator checks that a citation exists in the candidate set — it cannot check that the cited text is *relevant*. Chunking is where that is won or lost.

## Global Constraints

- Node `>=22.22.3`. TypeScript strict; `exactOptionalPropertyTypes: true`.
- ESM only; TypeScript source imports carry the `.js` extension.
- **Everything in professional English**: comments, identifiers, test names, error messages, fixtures.
- **RLS remains the sole tenant isolation mechanism.** Every write goes through `withTenant`.
- Every `execute()` result goes through `rowsOf()`.
- **Tests never reach the network.** The crawler takes an injectable `fetch`.
- No new runtime dependencies.
- Commits carry **no attribution trailer of any kind**. `git add` with explicit paths, never `git add -A`.
- `pnpm build` is part of every task's verification.
- Any claim that a property is pinned must be proved by breaking the code and watching the test fail.

---

### Task 1: Chunking that does not cut sentences in half

**Files:**
- Create: `packages/ingest/package.json`, `packages/ingest/tsconfig.json`
- Create: `packages/ingest/src/chunk.ts`, `packages/ingest/src/chunk.test.ts`
- Create: `packages/ingest/src/index.ts`

**Interfaces:**
- Produces: `chunkText(text: string, opts?: ChunkOptions): Chunk[]` where `Chunk` is `{ ordinal: number; content: string }`

- [ ] **Step 1: Decide the boundaries before writing code**

Chunking is usually written as "split every N characters", and that is the wrong default here. A chunk that begins mid-sentence gives the model a fragment whose subject is missing, and the model will confidently attach the fragment to whatever context it does have. That produces a cited claim the source does not support — which the grounding validator cannot catch, because the citation *is* in the candidate set.

So: split on paragraph boundaries first, then on sentence boundaries, and only fall back to a hard character cut when a single sentence exceeds the maximum on its own. Overlap consecutive chunks by a small amount so a fact stated across a boundary appears whole in at least one chunk.

Defaults: target 900 characters, hard maximum 1200, overlap 120. State in a comment that these are a starting point tuned for prose, that the admin panel will expose them, and that the numbers matter — too small and a chunk loses its subject, too large and retrieval returns mostly irrelevant text that dilutes the prompt and the bill.

- [ ] **Step 2: Write the failing tests**

Cases that must hold, each of which is a real failure mode rather than a nicety:

- Text shorter than the target yields exactly one chunk containing all of it.
- A document of several paragraphs splits at paragraph boundaries, and **no chunk begins or ends mid-sentence** when the text permits it. Assert on the first and last characters rather than on chunk count — count is implementation, sentence integrity is the requirement.
- A single sentence longer than the hard maximum is split, because refusing to split it would silently drop content, which is worse than an awkward cut.
- Consecutive chunks overlap by roughly the configured amount, so a sentence spanning a boundary is whole somewhere.
- `ordinal` is sequential from zero with no gaps — `chunks.ordinal` is `NOT NULL` and the admin panel will display documents in that order.
- Windows line endings and multiple blank lines do not produce empty chunks. An empty chunk would be indexed, retrieved, and cited as evidence for nothing.
- Text that is entirely whitespace yields zero chunks, not one empty one.

- [ ] **Step 3: Implement, then verify**

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then break the sentence-boundary logic — make it a plain fixed-size cut — and confirm the mid-sentence test fails. Restore.

- [ ] **Step 4: Commit**

```bash
git add packages/ingest pnpm-lock.yaml
git commit -m "feat(ingest): chunk on sentence boundaries, not character counts"
```

---

### Task 2: Indexing a source end to end

**Files:**
- Create: `packages/ingest/src/index-source.ts`, `packages/ingest/src/index-source.test.ts`
- Modify: `packages/core/src/store.ts`, `packages/db/src/store.ts`, `packages/core/src/testing/fakes.ts`

**Interfaces:**
- Produces: `indexSource(args: { store: IngestStore; provider: Provider; tenantId: string; sourceId: string; title: string; text: string; embeddingModel: string }): Promise<{ documentId: string; chunkCount: number }>`

- [ ] **Step 1: Extend `Store` with the writes ingestion needs**

`Store` today is read-mostly plus two recording methods. Ingestion needs to create a document, insert chunks with embeddings, and move a source's status. Add them to the interface in `packages/core` and implement in `packages/db`:

- `createDocument({ tenantId, sourceId, title }): Promise<string>`
- `insertChunks({ tenantId, documentId, embeddingModel, chunks }): Promise<void>` where each chunk carries `ordinal`, `content`, and `embedding`
- `setSourceStatus({ tenantId, sourceId, status, error? }): Promise<void>`

`knowledge_sources.status` is constrained to `pending | indexing | ready | error`, so a typo becomes a database error rather than a silently wrong state.

- [ ] **Step 2: The orchestrator, and what it does when embedding fails**

`indexSource` sets the status to `indexing`, chunks the text, embeds each chunk, writes the document and chunks, then sets `ready`.

Two decisions to encode, both with their reasoning in comments:

**Embedding failures set the source to `error` with the message, and rethrow.** A source that silently stays `pending` is invisible: the business owner sees no error and no content, and has no way to tell whether indexing is slow or broken. Recording the failure on the row is what makes the admin panel able to say "this failed, here is why, retry".

**Chunks are written even if some embeddings failed** — with `embedding` left null for those. A chunk with text but no vector is still findable by the keyword path, which is exactly why the retrieval query fuses by rank rather than requiring both paths. Discarding the text because one vector is missing would lose content the business already gave us.

- [ ] **Step 3: Tests against a real database**

Use `freshPglite` and a `FakeProvider`. What must hold:

- A source indexes to `ready`, the document exists, and chunk count matches what `chunkText` produced for that input.
- Every chunk carries the `embeddingModel` it was embedded with — the retrieval query filters on it, so a wrong value here makes the content unfindable by the vector path without any error.
- **The indexed content is actually retrievable**: after indexing, `searchChunks` with a term from the text returns it. This is the test that proves ingestion and retrieval agree; the two halves can each look correct and still not meet.
- A provider whose `embed` throws leaves the source `error` with a message, and the chunks are still present with null embeddings.
- Indexing runs inside the tenant's context, so chunks land with the right `tenant_id` — assert by reading as another tenant and seeing nothing.

- [ ] **Step 4: Verification**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then break the `embeddingModel` write — hardcode a different value — and confirm the retrievability test fails. That mutation is the one that proves the two halves agree, so run it and report what you saw.

- [ ] **Step 5: Commit**

```bash
git add packages/ingest packages/core packages/db
git commit -m "feat(ingest): index a source and prove the content comes back"
```

---

### Task 3: Sources over HTTP, and a narrow crawler

**Files:**
- Create: `packages/ingest/src/html.ts`, `packages/ingest/src/html.test.ts`
- Create: `packages/ingest/src/crawl.ts`, `packages/ingest/src/crawl.test.ts`
- Create: `packages/server/src/sources.ts`, and extend `packages/server/src/server.test.ts`

- [ ] **Step 1: HTML to text**

`htmlToText(html: string): { title: string; text: string }`. Strip `script`, `style`, `nav`, `header`, `footer`, and `aside`; collapse whitespace; keep paragraph breaks so the chunker has boundaries to find. Title comes from `<title>`, falling back to the first `<h1>`, falling back to the URL.

No dependency: a regex-based strip is adequate for the pages a small business publishes, and a real parser is recorded as debt rather than pulled in now. Say that in a comment so the limitation is a decision rather than an oversight.

Tests: navigation and script content do not survive; paragraph breaks do; entities are decoded; a page with no `<title>` uses its `<h1>`.

- [ ] **Step 2: The crawler, deliberately narrow**

`crawl({ url, maxPages, sameOriginOnly, fetchImpl })` follows links breadth-first.

Limits are not optional, and each one prevents a specific failure:

- `maxPages`, defaulting to something small like 50 — an unbounded crawl on a large site is a self-inflicted outage.
- **Same origin only, by default.** Following an external link means indexing someone else's content into this business's knowledge base, and the assistant would then cite it as the business's own. That is worse than missing content.
- Skip anything that is not HTML by `content-type`, so a linked PDF or image does not become a chunk of binary noise.
- Deduplicate by normalised URL, so a site that links back to its own home page from every footer does not crawl it fifty times.
- A page that fails to fetch is skipped and recorded, not fatal. One broken link must not abandon a whole site.

Tests use an injected `fetchImpl` serving a small fake site: linked pages are followed, external links are not, `maxPages` stops it, a failing page does not abort the run, and a non-HTML response is skipped.

- [ ] **Step 3: The HTTP surface**

Add authenticated routes to the server: create a source of kind `text`, `url`, or `file`; list sources with their status; trigger indexing.

These are **admin** routes, not visitor routes. They must not use the public tenant-slug path the chat endpoint uses — that slug is public by design and shipped in page HTML. Until the admin session layer exists, gate them behind a bearer token read from the environment and note plainly in a comment that this is a placeholder for real admin authentication, with the admin-panel plan owning the replacement.

Say so in the report too. A temporary gate that nobody writes down becomes permanent.

- [ ] **Step 4: Verification**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then remove the same-origin restriction and confirm the external-link test fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add packages/ingest packages/server
git commit -m "feat(ingest): accept sources over HTTP and crawl within one origin"
```

---

## Definition of Done

- A business can add content as pasted text, and it becomes retrievable — proven by a test that indexes and then searches.
- Chunks respect sentence boundaries, overlap, and carry sequential ordinals; no chunk is empty.
- A failed embedding leaves a visible `error` status with its message, and does not discard the text.
- HTML becomes readable text with navigation and scripts removed.
- The crawler stays within one origin, honours a page limit, skips non-HTML, deduplicates, and survives a broken page.
- Admin routes are gated, and the placeholder nature of that gate is written in the code and the report.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (zero warnings) and `pnpm build` all green.
