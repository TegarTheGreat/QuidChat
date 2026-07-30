import type { WidgetConfig } from "./config.js"

/*
 * These types intentionally mirror `@quidchat/core`'s `Segment`, `EscalationReason`,
 * and `PipelineResult` (see `packages/core/src/types.ts`) rather than importing them.
 * The widget's `dependencies` must stay empty — a business pastes this bundle onto
 * its own site, and anything the widget depends on, its visitors download. The wire
 * format (JSON over HTTP) is the actual contract between this package and the
 * server, so declaring it locally is the correct boundary, not a shortcut.
 */

export type Segment =
  | { text: string; kind: "general" }
  | { text: string; kind: "business_claim"; citations: string[] }

export type EscalationReason =
  | "no_source"
  | "ungrounded"
  | "budget_exhausted"
  | "provider_unavailable"
  | "schema_invalid"
  | "handoff_limit"
  | "visitor_request"

/** A source the answer drew on. The title is what a visitor is shown. */
export type Citation = { chunkId: string; documentTitle: string }

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cachedTokens: number | null
}

export type PipelineResult =
  | { kind: "answered"; segments: Segment[]; citations: Citation[]; usage: TokenUsage }
  | { kind: "refused"; text: string; reason: EscalationReason; usage: TokenUsage }

/** The server always includes `conversationId` alongside the `PipelineResult`
 *  itself, so the widget can send it back on the visitor's next message. */
export type ChatResponse = PipelineResult & { conversationId: string }

export type SendMessageInput = {
  /** Absent on the first message of a conversation. */
  conversationId?: string
  message: string
}

const UNAVAILABLE_MESSAGE = "QuidChat is temporarily unavailable. Please try again in a moment."

/**
 * Sends one visitor message and returns the result.
 *
 * A `refused` result is returned like any other successful answer, never thrown —
 * refusal is the assistant correctly declining to invent an answer, not a failure.
 * Only genuine setup/operational problems (bad origin, unknown tenant, an outage)
 * become thrown errors, and each names its likely cause rather than the raw status
 * code or the server's internal error text, which the server deliberately does not
 * leak to begin with.
 */
export async function sendMessage(cfg: WidgetConfig, input: SendMessageInput): Promise<ChatResponse> {
  let res: Response
  try {
    res = await fetch(`${cfg.apiBase}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantSlug: cfg.tenantSlug,
        message: input.message,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      }),
    })
  } catch {
    // A network failure (offline, DNS, CORS preflight rejected, etc.) reaches here
    // as a thrown `TypeError` from `fetch`, not a response — treat it the same as a
    // `503`, since from the visitor's side both mean "nothing came back."
    throw new Error(UNAVAILABLE_MESSAGE)
  }

  if (res.status === 200) {
    return (await res.json()) as ChatResponse
  }

  if (res.status === 403) {
    // The single most likely setup mistake: the business has not added this domain
    // to the tenant's allowed origins. Naming that saves a support conversation.
    throw new Error(
      "This site is not authorized to use this QuidChat assistant. " +
        "Add this domain to the allowed origins for this tenant in the QuidChat dashboard.",
    )
  }

  if (res.status === 404) {
    throw new Error(
      "This QuidChat tenant key is unknown. Check the `data-quidchat-tenant` value on the script tag.",
    )
  }

  // 503, and anything else unexpected (400, 405, 500, ...): a neutral message.
  // Never the server's own error text — it already refuses to leak internals, and
  // echoing whatever comes back would just relay that leak one hop further.
  throw new Error(UNAVAILABLE_MESSAGE)
}
