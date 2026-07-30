import type { RoutingRule, Skill } from "./routing/router.js"
import type { Candidate, EscalationReason, Segment, TenantConfig } from "./types.js"

export interface Store {
  getTenantConfig(tenantId: string): Promise<TenantConfig>

  /** Hybrid search: RRF over the top-k keyword path and vector path. Scoped to the tenant by RLS. */
  searchChunks(args: {
    tenantId: string
    query: string
    embedding: number[]
    /**
     * The model used to produce `embedding`. Chunks embedded with a DIFFERENT model are
     * excluded: mixing two different vector spaces in one search doesn't error, it just
     * returns results that are irrelevant but look plausible. The `chunks.embedding_model`
     * column exists for exactly this reason (spec §3.3).
     */
    embeddingModel: string
    limit: number
    /**
     * Restricts both the keyword and the vector CTE to chunks whose document belongs to
     * one of these knowledge sources — the skill-scoping boundary from spec §3.5.
     * `undefined` (not passed at all) means unscoped: every source the tenant owns.
     * An empty array is a real, different case — a skill linked to NO source — and must
     * return no candidates, not fall back to "everything".
     */
    sourceIds?: string[]
  }): Promise<Candidate[]>

  /** All skills belonging to the tenant, enabled or not — filtering by `enabled` is
   *  the caller's job (the panel needs to show disabled skills too). */
  listSkills(tenantId: string): Promise<Skill[]>

  /** All routing rules belonging to the tenant, in no particular order — the caller
   *  sorts by `position` (see `route()` in `routing/router.ts`). */
  listRoutingRules(tenantId: string): Promise<RoutingRule[]>

  /** The knowledge source ids a skill is linked to, via `skill_sources`. */
  sourceIdsForSkill(args: { tenantId: string; skillId: string }): Promise<string[]>

  /** Increments `conversations.handoff_count` by one and returns the new value —
   *  the count the caller compares against `max_handoffs_per_conversation`. */
  incrementHandoffCount(args: { tenantId: string; conversationId: string }): Promise<number>

  /**
   * Matches a customer question against `canned_answers` — `static` mode's only
   * data source. Full-text match first, trigram similarity as a fallback for
   * near misses, best match first.
   *
   * MUST be filtered to `status = 'approved'`. A `draft` row is AI-proposed text
   * that no human has reviewed yet; the entire trustworthiness of `static` mode
   * rests on nothing reaching a customer before that review happens.
   */
  matchCannedAnswer(args: {
    tenantId: string
    question: string
  }): Promise<{ id: string; answer: string } | null>

  recordAnswer(args: {
    tenantId: string
    conversationId: string
    segments: Segment[]
    citedChunkIds: string[]
    /**
     * Which skill produced this answer, when routing selected one.
     *
     * Optional because a tenant with no skills configured still answers, and forcing a
     * value would mean inventing a fake "default skill" to mean "no routing happened".
     * The admin panel needs it to show whether a question went where the owner intended —
     * routing is configurable, and configuration you cannot observe is guesswork.
     */
    skillId?: string
  }): Promise<void>

  recordEscalation(args: {
    tenantId: string
    conversationId: string
    reason: EscalationReason
  }): Promise<void>

  /** Records the visitor's message. Called before retrieval so the transcript stays
   *  complete even when the turn ends in a refusal. */
  recordUserTurn(args: {
    tenantId: string
    conversationId: string
    text: string
  }): Promise<void>

  /** Creates the document row a knowledge source's content is chunked into. Returns its id. */
  createDocument(args: {
    tenantId: string
    sourceId: string
    title: string
    url?: string
  }): Promise<string>

  /**
   * Writes a batch of chunk rows for a document.
   *
   * `embedding` is nullable ON PURPOSE: a chunk whose embedding call failed is still
   * written here with `embedding: null`, so its text stays findable through the keyword
   * path in `searchChunks` — which fuses the keyword and vector paths by rank rather
   * than requiring both to succeed. Discarding a chunk because its vector is missing
   * would throw away content the business already gave us.
   */
  insertChunks(args: {
    tenantId: string
    documentId: string
    chunks: {
      ordinal: number
      content: string
      embedding: number[] | null
      embeddingModel: string
    }[]
  }): Promise<void>

  /**
   * Updates a knowledge source's indexing status. `error` should be supplied together
   * with `status: "error"`; it is cleared (set to null) on every other status so a
   * stale failure message doesn't linger past a successful re-index. `status` is
   * constrained at the database level to `pending | indexing | ready | error` — a typo
   * here becomes a database error rather than a silently wrong state.
   */
  setSourceStatus(args: {
    tenantId: string
    sourceId: string
    status: "pending" | "indexing" | "ready" | "error"
    error?: string
  }): Promise<void>
}
