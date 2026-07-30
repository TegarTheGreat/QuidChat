import type { ChannelAdapter, IncomingMessage } from "./types.js"
import { renderForChannel } from "./types.js"

/** What the pipeline gives back, narrowed to what a channel needs. */
export type ChannelAnswer =
  | {
      kind: "answered"
      segments: { text: string; kind: "general" | "business_claim" }[]
      citations: { chunkId: string; documentTitle: string }[]
    }
  | { kind: "refused"; text: string; reason: string }

export type ChannelResult =
  | { status: "answered" | "refused"; sent: true }
  | { status: "ignored"; sent: false; why: string }
  | { status: "rejected"; sent: false; why: string }

/**
 * Runs one inbound webhook through an adapter and answers on the same channel.
 *
 * The pipeline is passed in rather than imported, so this module stays free of database
 * and provider concerns and every channel goes through the identical path. That sameness
 * is the point: routing, retrieval, grounding, refusal and spend all behave as they do on
 * the website, because the promise the product makes does not change with the transport.
 *
 * Verification comes first, before anything is parsed or stored. An unverified webhook can
 * put words into a business's conversation history and spend its budget, so a forged
 * request must not reach the pipeline at all — not even to be refused.
 */
export async function handleChannelMessage(args: {
  adapter: ChannelAdapter
  rawBody: string
  headers: Record<string, string | string[] | undefined>
  query?: Record<string, string>
  answer: (message: IncomingMessage) => Promise<ChannelAnswer>
  logError?: (message: string, cause: unknown) => void
}): Promise<ChannelResult> {
  const { adapter, rawBody, headers, answer } = args
  const logError = args.logError ?? ((m: string, c: unknown) => console.error(m, c))

  if (adapter.verify && !adapter.verify({ body: rawBody, headers })) {
    return { status: "rejected", sent: false, why: "signature verification failed" }
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { status: "rejected", sent: false, why: "body is not JSON" }
  }

  const incoming = adapter.parse(body, args.query ?? {})
  if (!incoming) {
    // Delivery receipts, typing indicators, bot echoes and non-text media all land here.
    // They are valid traffic, so this is not an error — treating it as one would fill the
    // logs and bury the failures that matter.
    return { status: "ignored", sent: false, why: "not a customer text message" }
  }

  // Same reason as the web route: a NUL byte cannot be stored in a Postgres text column, and a
  // message carrying one would fail after the platform had already been told the webhook
  // succeeded — leaving a customer waiting for an answer that was never going to come.
  const result = await answer({ ...incoming, text: incoming.text.replaceAll("\u0000", "") })

  const text =
    result.kind === "answered"
      ? renderForChannel({
          segments: result.segments,
          // Only claims about the business need attribution; a greeting does not.
          sources: result.segments.some((s) => s.kind === "business_claim")
            ? result.citations.map((c) => c.documentTitle)
            : [],
        })
      : result.text

  try {
    await adapter.send({ replyTo: incoming.replyTo, text, sources: [] })
  } catch (cause) {
    // The answer was produced and recorded; only delivery failed. Logging operationally
    // rather than throwing means the platform gets its 200 and stops retrying a webhook
    // that already did its work — a retry would answer the same question again and bill
    // for it twice.
    logError(`${adapter.id} delivery failed`, cause)
  }

  return { status: result.kind === "answered" ? "answered" : "refused", sent: true }
}
