import type { Candidate, EscalationReason, Segment, TenantConfig } from "./types.js"

export interface Store {
  getTenantConfig(tenantId: string): Promise<TenantConfig>

  /** Hybrid search: RRF atas top-k jalur kata kunci dan jalur vektor. Dibatasi tenant oleh RLS. */
  searchChunks(args: {
    tenantId: string
    query: string
    embedding: number[]
    /**
     * Model yang dipakai membuat `embedding`. Chunk yang di-embed dengan model LAIN
     * dikecualikan: dua ruang vektor berbeda dalam satu pencarian tidak error, ia hanya
     * mengembalikan hasil yang tidak relevan tapi terlihat masuk akal. Kolomnya ada di
     * `chunks.embedding_model` justru untuk ini (spec §3.3).
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

  /** Mencatat pesan pengunjung. Dipanggil sebelum retrieval supaya transkrip utuh
   *  bahkan ketika turn-nya berakhir dengan penolakan. */
  recordUserTurn(args: {
    tenantId: string
    conversationId: string
    text: string
  }): Promise<void>
}
