export type Segment =
  | { text: string; kind: "general" }
  | { text: string; kind: "business_claim"; citations: string[] }

export type Answer = { segments: Segment[] }

export type Candidate = {
  id: string
  content: string
  documentTitle: string
}

export type TenantConfig = {
  chatModel: string
  rewriteModel: string
  /**
   * The embedding model. SEPARATE from `chatModel` — embedding with a chat model id
   * would be rejected by a real provider. The column has existed in `tenant_settings`
   * since the first migration; this type just didn't expose it until now.
   */
  embeddingModel: string
  refusalText: string
  highRiskTopics: string[]
}

export type EscalationReason =
  | "no_source"
  | "ungrounded"
  | "budget_exhausted"
  | "provider_unavailable"
  | "schema_invalid"
  | "handoff_limit"
  | "visitor_request"

/**
 * A source the answer drew on, carried far enough to be shown to a visitor.
 *
 * The chunk id alone is not enough. The product's central claim is that a visitor can
 * see where an answer came from, and `7f3a9c2e-…` satisfies the shape of that claim
 * without satisfying its purpose. The title is already on `Candidate` when the pipeline
 * validates, so carrying it costs nothing but was previously dropped at this boundary.
 */
export type Citation = { chunkId: string; documentTitle: string }

/** What a turn cost, summed across every provider call the turn made. */
export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  /** `null` means the provider did not report it — not that nothing was cached. */
  cachedTokens: number | null
}

/**
 * Both variants carry `usage`, and that is deliberate.
 *
 * A refusal is not free. The `ungrounded` path runs the generation twice before giving
 * up, and `no_source` still pays for an embedding. Reporting usage only on success
 * would let the most expensive outcome in the system — repeated ungrounded answers that
 * never reach a visitor — accumulate no recorded spend at all, so a budget could never
 * stop it.
 */
export type PipelineResult =
  | { kind: "answered"; segments: Segment[]; citations: Citation[]; usage: TokenUsage }
  | { kind: "refused"; text: string; reason: EscalationReason; usage: TokenUsage }
