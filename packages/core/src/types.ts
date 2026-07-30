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
