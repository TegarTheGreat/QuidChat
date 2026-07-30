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
