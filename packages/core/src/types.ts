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

export type PipelineResult =
  | { kind: "answered"; segments: Segment[]; citedChunkIds: string[] }
  | { kind: "refused"; text: string; reason: EscalationReason }
