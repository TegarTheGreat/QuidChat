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
}
