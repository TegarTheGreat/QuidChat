/**
 * A channel is any place a customer can talk to a business: the website widget,
 * WhatsApp, Telegram, Discord.
 *
 * They differ only in how a message arrives and how a reply is sent. Everything between —
 * routing, retrieval, grounding, refusal, spend — is the same pipeline, because the
 * promise the product makes does not change with the transport. An adapter that reached
 * into the pipeline to "handle WhatsApp differently" would be a place where the grounding
 * guarantee could quietly stop holding.
 */

export type IncomingMessage = {
  /** Which business this belongs to. */
  tenantSlug: string
  /**
   * Stable per person per channel. It becomes `conversations.visitor_id`, so the same
   * customer returning gets their history — which is why it must not be a message id or
   * anything else that changes per message.
   */
  visitorId: string
  text: string
  /** Where to send the reply. Opaque to the pipeline; only the adapter interprets it. */
  replyTo: string
}

export type OutgoingMessage = {
  replyTo: string
  text: string
  /**
   * Document titles backing any business claim in the answer.
   *
   * Carried separately from `text` because channels render attribution differently: the
   * widget shows a line under the bubble, WhatsApp has no such affordance and needs it
   * appended. Dropping it would quietly remove the one thing that makes an answer
   * checkable by the person reading it.
   */
  sources: string[]
}

/**
 * What an adapter must provide. Deliberately small: parse an inbound request, send a
 * reply, and say who you are.
 */
export type ChannelAdapter = {
  /** Used as `conversations.channel`, so it appears in the admin panel and in analytics. */
  readonly id: string

  /**
   * Turns a raw webhook body into a message, or null when the request is not a customer
   * message at all — a delivery receipt, a typing indicator, a bot's own echo.
   *
   * Returning null rather than throwing matters: webhooks deliver plenty of traffic that
   * is valid and uninteresting, and treating that as an error would fill the logs and
   * make real failures invisible.
   */
  parse(body: unknown, query: Record<string, string>): IncomingMessage | null

  /** Sends the reply. Throws on transport failure so the caller can decide. */
  send(message: OutgoingMessage): Promise<void>

  /**
   * Verifies the request genuinely came from the platform.
   *
   * Optional only because some platforms offer nothing to verify against. Where a secret
   * or signature exists, this must use it — a webhook endpoint without verification lets
   * anyone put words in a business's conversation history and spend its budget.
   */
  verify?(args: { body: string; headers: Record<string, string | string[] | undefined> }): boolean
}

/**
 * Renders an answer as channel text.
 *
 * Sources are appended rather than interleaved, because a claim-by-claim citation reads
 * as noise in a chat app while a short trailer still lets the customer check the source.
 * The widget does it properly per claim; here the constraint is the medium.
 */
export function renderForChannel(args: {
  segments: { text: string; kind: "general" | "business_claim" }[]
  sources: string[]
}): string {
  const body = args.segments.map((s) => s.text).join(" ")
  if (args.sources.length === 0) return body
  const unique = [...new Set(args.sources)]
  return `${body}\n\n— ${unique.join(", ")}`
}
