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
  | "rate_limited"
  // A reason this widget has not heard of must not break it. A bundle already pasted onto a
  // customer's site outlives the server it talks to, so a server that grows a new reason has to
  // be safe for the widget that shipped before it.
  | (string & {})

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

/** What the server reports while it works. `retrieving` is nearly always the slow part on a
 *  large knowledge base, and `validating` is the step a visitor benefits from knowing exists. */
export type ProgressStage = "retrieving" | "generating" | "validating"

export type SendMessageInput = {
  /** Absent on the first message of a conversation. */
  conversationId?: string
  message: string
}

/**
 * Shown to a visitor on the business's own site, so it does not name QuidChat.
 *
 * The other messages in this file are aimed at whoever pasted the script tag — an unlisted
 * origin, an unknown tenant key — and naming the product there is exactly what makes them
 * actionable. This one is different: it is read by a customer of a shop who has never heard of
 * QuidChat and does not need to, and a vendor's name appearing mid-conversation reads as the
 * shop's site being broken by something foreign to it.
 */
const UNAVAILABLE_MESSAGE = "The assistant is temporarily unavailable. Please try again in a moment."

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
/**
 * The message for a non-200, or `null` when the status is one the caller should handle itself.
 *
 * Extracted so the streaming path does not have to re-issue the request just to learn what a
 * 403 or a 429 means. Re-issuing would ask the same question twice, and on a route that bills
 * per answer that is not a harmless retry.
 */
function errorForStatus(res: Response): string | null {
  if (res.status === 403) {
    // The single most likely setup mistake: the business has not added this domain to the
    // tenant's allowed origins. Naming that saves a support conversation.
    return (
      "This site is not authorized to use this QuidChat assistant. " +
      "Add this domain to the allowed origins for this tenant in the QuidChat dashboard."
    )
  }
  if (res.status === 429) {
    // Distinct from an outage on purpose. "Temporarily unavailable" tells a visitor something
    // is broken and invites an immediate retry, which is precisely the behaviour the limit
    // exists to stop; naming the wait tells them what happened and what to do. `Retry-After`
    // is turned into seconds so the wait named here is the real one rather than a guess.
    const retryAfter = Number(res.headers.get("retry-after") ?? "")
    const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 5
    return `You are sending messages too quickly. Please wait ${seconds} second${seconds === 1 ? "" : "s"} and try again.`
  }
  return null
}

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

  const known = errorForStatus(res)
  if (known) throw new Error(known)

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

/**
 * Sends one message and reports progress while the answer is produced.
 *
 * The answer is NOT streamed token by token, and the server will not do it: grounding
 * validation runs on the complete answer, so streaming raw tokens would put an unvalidated
 * claim in front of a customer — the precise failure this product exists to prevent. What
 * streams is the *stage*, which is what makes a five-second wait legible instead of a dead
 * spinner.
 *
 * Falls back to the plain request on ANY problem with the stream: an old server without the
 * route, a proxy that buffers events, a body that is not an event stream. A visitor must never
 * lose the ability to get an answer because a progress indicator did not work, so the fallback
 * is the same `sendMessage` this module has always exported.
 */
export async function sendMessageWithProgress(
  cfg: WidgetConfig,
  input: SendMessageInput,
  onProgress: (stage: ProgressStage) => void,
): Promise<ChatResponse> {
  let res: Response
  try {
    res = await fetch(`${cfg.apiBase}/v1/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantSlug: cfg.tenantSlug,
        message: input.message,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      }),
    })
  } catch {
    return sendMessage(cfg, input)
  }

  // A 403 or a 429 means the same thing here as on the plain route, so it is reported rather
  // than retried: retrying would ask the same question a second time.
  const known = errorForStatus(res)
  if (known) throw new Error(known)

  // A 404 is ambiguous — an unknown tenant, or a server old enough not to have this route at
  // all — and only the plain route can tell them apart. Nothing has been answered yet either
  // way, so asking there is safe and produces the right message or the answer itself.
  if (res.status === 404) return sendMessage(cfg, input)
  if (res.status !== 200 || !res.body) return sendMessage(cfg, input)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let result: ChatResponse | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Events are separated by a blank line. Anything after the last one is a partial event and
    // stays in the buffer — parsing it would drop the tail of a payload split across packets.
    const events = buffer.split("\n\n")
    buffer = events.pop() ?? ""

    for (const raw of events) {
      const nameLine = raw.split("\n").find((l) => l.startsWith("event:"))
      const dataLine = raw.split("\n").find((l) => l.startsWith("data:"))
      if (!nameLine || !dataLine) continue
      const name = nameLine.slice("event:".length).trim()
      let data: unknown
      try {
        data = JSON.parse(dataLine.slice("data:".length).trim())
      } catch {
        continue
      }

      if (name === "progress") {
        const stage = (data as { stage?: string }).stage
        if (stage === "retrieving" || stage === "generating" || stage === "validating") {
          onProgress(stage)
        }
      } else if (name === "result") {
        result = data as ChatResponse
      } else if (name === "error") {
        // The server's own text is written for an operator, and it does not change what the
        // visitor should do. An explicit failure and a cut connection are handled the same way
        // below, so the event only needs to stop us looking for a result.
        break
      }
    }
  }

  if (result) return result

  // Nothing is retried from here, and that is the deliberate choice. The stream reached the
  // server, so the question may already have been answered, recorded and billed — a second
  // attempt would answer it again and charge the business twice for one customer message. A
  // visitor being told to try again is recoverable; a duplicate answer against a budget is not.
  throw new Error(UNAVAILABLE_MESSAGE)
}
