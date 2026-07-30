import type { Candidate, EscalationReason, Segment, TenantConfig } from "./types.js"

export interface Store {
  getTenantConfig(tenantId: string): Promise<TenantConfig>

  /** Hybrid search: vector + full text, sudah di-rerank, dibatasi tenant. */
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
