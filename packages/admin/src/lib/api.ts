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
  title: string
  status: SourceStatus
  error?: string | null
  createdAt?: string
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
  citations?: Citation[]
}

export interface Conversation {
  id: string
  tenantSlug?: string
  startedAt?: string
  channel?: string
  messages: ConversationMessage[]
}

export interface Escalation {
  id: string
  reason: string
  createdAt: string
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

// ---- Endpoints ------------------------------------------------------------

export const api = {
  listTenants: () => request<Tenant[]>("/v1/admin/tenants"),

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
    request<Source[]>(`/v1/admin/sources${query({ tenantSlug })}`),

  createTextSource: (body: { tenantSlug: string; title: string; text: string }) =>
    request<Source>("/v1/admin/sources/text", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listConversations: (tenantSlug: string) =>
    request<Conversation[]>(`/v1/admin/conversations${query({ tenantSlug })}`),

  listEscalations: (tenantSlug: string) =>
    request<Escalation[]>(`/v1/admin/escalations${query({ tenantSlug })}`),

  getUsage: (tenantSlug: string) =>
    request<Usage>(`/v1/admin/usage${query({ tenantSlug })}`),

  /** What is stopping this tenant from answering. Needs no provider, so it works even
   *  when nothing is configured — which is exactly when an owner needs it. */
  getSetup: (tenantSlug: string) =>
    request<SetupStatus>(`/v1/admin/setup${query({ tenantSlug })}`),
}
