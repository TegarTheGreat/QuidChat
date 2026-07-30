import { createHmac, timingSafeEqual } from "node:crypto"
import {
  renderForChannel,
  splitForChannel,
  type ChannelAdapter,
  type IncomingMessage,
} from "./types.js"

/**
 * LINE, through the Messaging API.
 *
 * Worth having for the same reason WhatsApp is: in much of Asia it is where customers already
 * are, and asking them to come to a website instead is asking them not to bother.
 *
 * Verification is `x-line-signature`, a Base64 HMAC-SHA256 over the raw request body, keyed with
 * the channel secret — taken from developers.line.biz/en/reference/messaging-api. Base64 rather
 * than hex, which is the detail that quietly breaks an implementation copied from another
 * platform.
 *
 * A reply is addressed to a `replyToken`, not to a user, and that token is single-use and
 * short-lived. So the answer must be sent once and promptly; there is no queueing it, and no
 * sending a correction afterwards.
 */

/** LINE's limit for one text message object. */
const LINE_TEXT_LIMIT = 5000
/** How many message objects one reply may carry. A longer answer is truncated rather than lost —
 *  see the note in `send`. */
const LINE_MAX_MESSAGES = 5

export function lineAdapter(opts: {
  tenantSlug: string
  /** Channel access token, for the reply endpoint. */
  accessToken: string
  /** Channel secret, for signature verification. Strongly recommended. */
  channelSecret?: string
  fetchImpl?: typeof fetch
}): ChannelAdapter {
  const f = opts.fetchImpl ?? fetch

  return {
    id: "line",

    parse(body: unknown): IncomingMessage | null {
      const payload = body as {
        events?: {
          type?: unknown
          replyToken?: unknown
          message?: { type?: unknown; text?: unknown }
          source?: { userId?: unknown }
        }[]
      }
      // LINE batches events. Only the first customer text is answered: each reply token belongs
      // to one event, and answering several in one turn would need several tokens and several
      // trips through the pipeline.
      const event = payload.events?.find(
        (e) => e.type === "message" && e.message?.type === "text",
      )
      if (!event) return null

      const text = event.message?.text
      const userId = event.source?.userId
      const replyToken = event.replyToken
      if (typeof text !== "string" || text.trim() === "") return null
      // A follow, a join, a sticker and a delivery receipt all arrive here without these.
      if (typeof userId !== "string" || typeof replyToken !== "string") return null

      return {
        tenantSlug: opts.tenantSlug,
        visitorId: `line:${userId}`,
        text,
        replyTo: replyToken,
      }
    },

    async send(message): Promise<void> {
      const body = renderForChannel({
        segments: [{ text: message.text, kind: "general" }],
        sources: message.sources,
      })
      // A reply token is single-use, so every piece goes in ONE request as separate message
      // objects. Sending them as separate requests would fail on the second.
      const parts = splitForChannel(body, LINE_TEXT_LIMIT).slice(0, LINE_MAX_MESSAGES)

      const res = await f("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          replyToken: message.replyTo,
          messages: parts.map((text) => ({ type: "text", text })),
        }),
      })
      if (!res.ok) {
        throw new Error(`line reply failed with ${res.status}`)
      }
    },

    verify({ body, headers }): boolean {
      if (!opts.channelSecret) return true
      const header = headers["x-line-signature"]
      const presented = Array.isArray(header) ? header[0] : header
      if (typeof presented !== "string") return false

      // Base64, not hex. An implementation copied from a platform that uses hex verifies nothing
      // and rejects everything, which looks like a configuration problem rather than a bug.
      const expected = createHmac("sha256", opts.channelSecret).update(body).digest("base64")
      const a = Buffer.from(presented)
      const b = Buffer.from(expected)
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    },
  }
}
