import { getToken } from "./token"

/**
 * Client for the QuidChat admin API.
 *
 * Written against the contract the server team is building concurrently
 * (`packages/server/src/*`, mounted under `/v1/admin/...`). Nothing here
 * blocks on those routes existing yet — a 404 today is expected, and once
 * they land this file does not need to change.
 */

const API_BASE = (import.meta.env["VITE_API_BASE"] as string | undefined) ?? ""

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** Reads the server's error text verbatim. The API is documented to return
 *  actionable messages (an unknown settings column, a missing origin) — an
 *  unknown-column typo here would silently swallow the one thing that helps
 *  the operator fix their request. */
async function extractErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return `Request failed with status ${response.status}`
  try {
    const body: unknown = JSON.parse(text)
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>
      if (typeof record["error"] === "string") return record["error"]
      if (typeof record["message"] === "string") return record["message"]
    }
  } catch {
    // Not JSON — the raw text is the message.
  }
  return text
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (!response.ok) {
    throw new ApiError(await extractErrorMessage(response), response.status)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

function query(params: Record<string, string | undefined>): string {
  const usable = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
  if (usable.length === 0) return ""
  return `?${new URLSearchParams(usable).toString()}`
}

// ---- Domain types --------------------------------------------------------

export interface Tenant {
  slug: string
  name: string
  origins: string[]
}

export interface Settings {
  tenantSlug: string
  answer_mode: "static" | "thrifty" | "full"
  chat_model: string
  rewrite_model: string
  embedding_model: string
  refusal_text: string
  escalation_mode: string
  escalation_target: string
  monthly_budget_cents: number
  retention_days: number
  high_risk_topics: string[]
  allowed_origins: string[]
  max_handoffs_per_turn: number
  max_handoffs_per_conversation: number
  widget_theme: Record<string, unknown>
}

export type SourceStatus = "pending" | "ready" | "error" | (string & {})

export interface Source {
  id: string
  /** The document's own name — what a customer sees attached to an answer. */
  title: string
  /** Where it came from: the URL for a page, the title itself for pasted text. */
  uri?: string
  kind?: "text" | "url" | (string & {})
  status: SourceStatus
  error?: string | null
  lastIndexedAt?: string | null
}

export interface Citation {
  sourceId: string
  title: string
}

export interface ConversationMessage {
  id?: string
  role: "user" | "assistant" | (string & {})
  content: string
  createdAt?: string
  /** The skill that answered, when routing selected one. A wrong answer and a wrongly-routed
   *  answer look identical without it, and they need different fixes. */
  skillName?: string | null
  citations?: Citation[]
}

/** A row in the list. Messages are NOT here: fifty transcripts with every message is a
 *  payload that grows with traffic and is almost entirely thrown away. */
export interface Conversation {
  id: string
  channel?: string
  visitorId?: string
  status?: string
  createdAt?: string
  messageCount?: number
}

/** One transcript, fetched when a reader opens it. */
export interface ConversationDetail {
  id: string
  channel?: string
  visitorId?: string
  status?: string
  startedAt?: string
  messages: ConversationMessage[]
}

export interface Escalation {
  id: string
  reason: string
  /** When the assistant gave up, not when the conversation started — the two differ whenever
   *  one conversation escalates more than once, and this list is read newest first. */
  occurredAt: string
  resolvedAt: string | null
  /** The customer's last question. Null only for an escalation recorded without one. */
  question: string | null
  conversationId?: string
}

export interface Usage {
  monthlyCostCents?: number
  monthlyTokens?: number
  [key: string]: unknown
}


export interface SetupFinding {
  id: string
  severity: "blocker" | "warning" | "suggestion"
  title: string
  why: string
  fix: string
}

export interface SetupStatus {
  ready: boolean
  findings: SetupFinding[]
  snapshot: Record<string, unknown>
}

export interface Skill {
  id: string
  name: string
  description: string | null
  systemPrompt: string | null
  enabled: boolean
  isFallback: boolean
  answerMode: string | null
  sources: { sourceId: string; uri: string }[]
}

export interface RoutingRule {
  id: string
  skillId: string
  position: number
  kind: "keyword" | "semantic" | "llm" | "fallback"
  pattern: string | null
  enabled: boolean
}

// ---- Endpoints ------------------------------------------------------------

export interface CannedAnswer {
  id: string
  question: string
  answer: string
  status: "draft" | "approved"
  createdAt: string
}

export const api = {
  // Every list endpoint answers with a NAMED object — { tenants: [...] } — and every caller
  // wants the array. Unwrapping here rather than in each page is why these types can stay
  // arrays: the shape a page sees is the shape it uses, and the wire shape lives in one place.
  listTenants: () =>
    request<{ tenants: Tenant[] }>("/v1/admin/tenants").then((r) => r.tenants),

  createTenant: (body: { slug: string; name: string; origins: string[] }) =>
    request<Tenant>("/v1/admin/tenants", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getSettings: (tenantSlug: string) =>
    request<Settings>(`/v1/admin/settings${query({ tenantSlug })}`),

  updateSettings: (body: Partial<Settings> & { tenantSlug: string }) =>
    request<Settings>("/v1/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  listSources: (tenantSlug: string) =>
    request<{ sources: Source[] }>(`/v1/admin/sources${query({ tenantSlug })}`).then(
      (r) => r.sources,
    ),

  /** Reads a page and indexes it. Private and local addresses are refused by the server,
   *  including via a redirect, so a URL a visitor could supply cannot be turned into a
   *  request to something on the deployment's own network. */
  createUrlSource: (body: { tenantSlug: string; url: string; title?: string }) =>
    request<{ sourceId: string; title: string; url: string; status: string; error?: string }>(
      "/v1/admin/sources/url",
      { method: "POST", body: JSON.stringify(body) },
    ),

  createTextSource: (body: { tenantSlug: string; title: string; text: string }) =>
    request<Source>("/v1/admin/sources/text", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Removes a source and, by cascade, its documents and chunks. `chunksRemoved` is what
   *  actually disappeared — the count is taken before the delete, since a cascade cannot
   *  report what it took. */
  deleteSource: (body: { tenantSlug: string; id: string }) =>
    request<{ ok: true; chunksRemoved: number }>("/v1/admin/sources", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),

  listConversations: (tenantSlug: string) =>
    request<{ conversations: Conversation[] }>(
      `/v1/admin/conversations${query({ tenantSlug })}`,
    ).then((r) => r.conversations),

  getConversation: (tenantSlug: string, id: string) =>
    request<{ conversation: ConversationDetail }>(
      `/v1/admin/conversation${query({ tenantSlug, id })}`,
    ).then((r) => r.conversation),

  listEscalations: (tenantSlug: string) =>
    request<{ escalations: Escalation[] }>(`/v1/admin/escalations${query({ tenantSlug })}`).then(
      (r) => r.escalations,
    ),

  getUsage: (tenantSlug: string) =>
    request<Usage>(`/v1/admin/usage${query({ tenantSlug })}`),

  /** What is stopping this tenant from answering. Needs no provider, so it works even
   *  when nothing is configured — which is exactly when an owner needs it. */
  getSetup: (tenantSlug: string) =>
    request<SetupStatus>(`/v1/admin/setup${query({ tenantSlug })}`),

  /** Skills, their linked sources and the routing rules together — they are only
   *  meaningful together, and an owner debugging a misrouted question needs all three. */
  getSkills: (tenantSlug: string) =>
    request<{ skills: Skill[]; rules: RoutingRule[] }>(`/v1/admin/skills${query({ tenantSlug })}`),

  createSkill: (body: {
    tenantSlug: string
    name: string
    description?: string
    systemPrompt?: string
    isFallback?: boolean
    answerMode?: string
  }) => request<{ skill: { id: string; name: string } }>("/v1/admin/skills", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  linkSkillSource: (body: {
    tenantSlug: string
    skillId: string
    sourceId: string
    linked: boolean
  }) => request<{ ok: boolean }>("/v1/admin/skills/sources", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  createRoutingRule: (body: {
    tenantSlug: string
    skillId: string
    kind: string
    pattern?: string
    position?: number
  }) => request<{ rule: { id: string; position: number } }>("/v1/admin/routing-rules", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  listCannedAnswers: (tenantSlug: string) =>
    request<{ cannedAnswers: CannedAnswer[] }>(`/v1/admin/canned-answers${query({ tenantSlug })}`),

  createCannedAnswer: (body: {
    tenantSlug: string
    question: string
    answer: string
    /** The panel sends `true`: a person typing the answer here IS the human review the
     *  draft state exists to require. Other callers leave it off and get a draft. */
    approved?: boolean
  }) =>
    request<{ cannedAnswer: CannedAnswer }>("/v1/admin/canned-answers", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  setCannedAnswerStatus: (body: { tenantSlug: string; id: string; approved: boolean }) =>
    request<{ cannedAnswer: { id: string; status: string } }>("/v1/admin/canned-answers/status", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteCannedAnswer: (body: { tenantSlug: string; id: string }) =>
    request<{ ok: true }>("/v1/admin/canned-answers", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
}
