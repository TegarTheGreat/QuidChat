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

/**
 * A row from `GET /admin/tenants`.
 *
 * No `origins`: the list route does not send them, and declaring a field the server never
 * sends is how a screen ends up rendering `undefined`. Allowed origins live in settings, which
 * is where the panel edits them.
 */
export interface Tenant {
  id: string
  slug: string
  name: string
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
  kind?: "text" | "url" | "file" | (string & {})
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

/**
 * This month's spend, exactly as `GET /admin/usage` names it.
 *
 * No index signature. The previous shape had one, so `usage.data["monthlyCostCents"]` — a field
 * the server has never sent — typechecked and rendered as an empty figure on the overview
 * screen. A type that accepts any key cannot disagree with the server, which is the only useful
 * thing a type can do here.
 */
export interface Usage {
  inputTokens: number
  outputTokens: number
  costCents: number
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

export type ChannelId = "telegram" | "whatsapp" | "waha" | "discord" | "slack" | "line"

export interface ChannelStatus {
  channel: ChannelId
  enabled: boolean
  updatedAt: string
  /** Which credential fields are stored — never their values. The API does not return them,
   *  not even masked: a field showing part of a bot token leaks part of a bot token. */
  configuredFields: string[]
  /** Set when the stored credentials cannot be read, which in practice means the encryption
   *  key changed. Shown as-is, because it names the fix. */
  error: string | null
}

export interface ProvidersResponse {
  /** False when the deployment has no QUIDCHAT_SECRET_KEY, so no credential can be stored. */
  secretKeyConfigured: boolean
  /** Which credential names are stored. Never the values. */
  configuredFields: string[]
  chatProvider: string | null
  embedProvider: string | null
}

export interface ChannelForm {
  id: string
  title: string
  hint: string
  fields: { name: string; label: string; required: boolean; secret: boolean }[]
}

export interface ChannelsResponse {
  /** False when QUIDCHAT_SECRET_KEY is unset. Nothing can be saved without it, so the panel
   *  says so instead of offering a form that will fail. */
  secretKeyConfigured: boolean
  fields: Record<string, { required: string[]; optional: string[] }>
  /** Every channel this server supports, with its labels. Rendered from here rather than from a
   *  list in the panel, which could fall behind the server it is talking to. */
  forms: ChannelForm[]
  channels: ChannelStatus[]
}

export const api = {
  // Every list endpoint answers with a NAMED object — { tenants: [...] } — and every caller
  // wants the array. Unwrapping here rather than in each page is why these types can stay
  // arrays: the shape a page sees is the shape it uses, and the wire shape lives in one place.
  listTenants: () =>
    request<{ tenants: Tenant[] }>("/v1/admin/tenants").then((r) => r.tenants),

  /** `created` distinguishes a new tenant from an updated one — the route is an upsert, so a
   *  caller that wants to say "created" rather than "saved" needs to be told which happened. */
  createTenant: (body: { slug: string; name: string; origins: string[] }) =>
    request<Tenant & { created: boolean }>("/v1/admin/tenants", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  renameTenant: (body: { slug: string; name: string }) =>
    request<{ tenant: { slug: string; name: string } }>("/v1/admin/tenants", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** `confirm` must repeat the slug — see the route's own note on why. */
  deleteTenant: (body: { slug: string; confirm: string }) =>
    request<{ ok: true }>("/v1/admin/tenants", { method: "DELETE", body: JSON.stringify(body) }),

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
  getProviders: (tenantSlug: string) =>
    request<ProvidersResponse>(`/v1/admin/providers${query({ tenantSlug })}`),

  getProviderModels: (tenantSlug: string) =>
    request<{ models: string[]; error: string | null }>(
      `/v1/admin/providers/models${query({ tenantSlug })}`,
    ),

  saveProviders: (body: {
    tenantSlug: string
    secrets: Record<string, string>
    chatProvider?: string | null
    embedProvider?: string | null
  }) =>
    request<Omit<ProvidersResponse, "secretKeyConfigured">>("/v1/admin/providers", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  clearProviders: (body: { tenantSlug: string }) =>
    request<{ ok: true }>("/v1/admin/providers", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),

  createUrlSource: (body: { tenantSlug: string; url: string; title?: string }) =>
    request<{ sourceId: string; title: string; url: string; status: string; error?: string }>(
      "/v1/admin/sources/url",
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** Reports what indexing produced, not a `Source` row: the count is the useful part, and a
   *  source that failed to embed comes back with `status: "error"` and the reason. */
  createPdfSource: (body: { tenantSlug: string; title: string; data: string }) =>
    request<{ sourceId: string; status: string; pageCount?: number; chunkCount?: number }>(
      "/v1/admin/sources/pdf",
      { method: "POST", body: JSON.stringify(body) },
    ),

  createTextSource: (body: { tenantSlug: string; title: string; text: string }) =>
    request<{
      sourceId: string
      documentId?: string
      chunkCount?: number
      status: string
      error?: string
    }>("/v1/admin/sources/text", {
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

  /** Marks an escalation handled, or puts it back. */
  resolveEscalation: (body: { tenantSlug: string; id: string; resolved: boolean }) =>
    request<{ id: string; resolvedAt: string | null }>("/v1/admin/escalations/resolve", {
      method: "POST",
      body: JSON.stringify(body),
    }),

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

  updateSkill: (body: {
    tenantSlug: string
    id: string
    name?: string
    systemPrompt?: string | null
    enabled?: boolean
    isFallback?: boolean
    answerMode?: string | null
  }) =>
    request<{ skill: { id: string; name: string } }>("/v1/admin/skills", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteSkill: (body: { tenantSlug: string; id: string }) =>
    request<{ ok: true }>("/v1/admin/skills", { method: "DELETE", body: JSON.stringify(body) }),

  deleteRoutingRule: (body: { tenantSlug: string; id: string }) =>
    request<{ ok: true }>("/v1/admin/routing-rules", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),

  updateCannedAnswer: (body: {
    tenantSlug: string
    id: string
    question?: string
    answer?: string
  }) =>
    request<{ cannedAnswer: { id: string; status: string } }>("/v1/admin/canned-answers", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  reindexSource: (body: { tenantSlug: string; id: string }) =>
    request<{ status: string; chunkCount?: number; error?: string }>("/v1/admin/sources/reindex", {
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

  listChannels: (tenantSlug: string) =>
    request<ChannelsResponse>(`/v1/admin/channels${query({ tenantSlug })}`),

  /** Whole-row replacement, not a patch: a business rotating a token must be able to tell
   *  what is actually stored, with no chance the old value is still there underneath. */
  saveChannel: (body: {
    tenantSlug: string
    channel: ChannelId
    enabled: boolean
    secrets: Record<string, string>
  }) =>
    request<{ channel: string; enabled: boolean; configuredFields: string[] }>(
      "/v1/admin/channels",
      { method: "PUT", body: JSON.stringify(body) },
    ),

  deleteChannel: (body: { tenantSlug: string; channel: ChannelId }) =>
    request<{ ok: true }>("/v1/admin/channels", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
}
