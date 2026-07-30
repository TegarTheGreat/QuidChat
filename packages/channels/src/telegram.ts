import { timingSafeEqual } from "node:crypto"
import {
  renderForChannel,
  splitForChannel,
  type ChannelAdapter,
  type IncomingMessage,
} from "./types.js"

/**
 * Telegram Bot API.
 *
 * Webhook body shape: `{ message: { chat: { id }, from: { id }, text } }`. Telegram also
 * delivers edits, channel posts, callback queries and its own bot echoes to the same
 * endpoint, so anything without a plain `message.text` from a human is not a customer
 * message and returns null.
 *
 * Verification uses the `X-Telegram-Bot-Api-Secret-Token` header, which Telegram echoes
 * from whatever secret was given at `setWebhook`. Without it the endpoint is open: anyone
 * who learns the URL can put words into a business's conversation history and spend its
 * budget.
 */
/** Telegram's own limit for a text message. */
const TELEGRAM_MESSAGE_LIMIT = 4096

export function telegramAdapter(opts: {
  tenantSlug: string
  botToken: string
  /** The secret passed to `setWebhook`. Strongly recommended. */
  secretToken?: string
  fetchImpl?: typeof fetch
}): ChannelAdapter {
  const f = opts.fetchImpl ?? fetch
  const api = `https://api.telegram.org/bot${opts.botToken}`

  return {
    id: "telegram",

    parse(body: unknown): IncomingMessage | null {
      const update = body as {
        message?: {
          text?: unknown
          chat?: { id?: unknown }
          from?: { id?: unknown; is_bot?: unknown }
        }
      }
      const message = update.message
      if (!message || typeof message.text !== "string" || message.text.trim() === "") {
        return null
      }
      // A bot's own message coming back would make the assistant answer itself, which
      // loops and bills for every turn.
      if (message.from?.is_bot === true) return null

      const chatId = message.chat?.id
      const fromId = message.from?.id
      if (chatId === undefined || fromId === undefined) return null

      return {
        tenantSlug: opts.tenantSlug,
        // The person, not the chat: in a group the chat is shared but the customer is not.
        visitorId: `telegram:${String(fromId)}`,
        text: message.text,
        replyTo: String(chatId),
      }
    },

    async send(message): Promise<void> {
      const body = renderForChannel({
        segments: [{ text: message.text, kind: "general" }],
        sources: message.sources,
      })
      // Telegram rejects anything past 4096 characters, and a grounded answer with its citations
      // reaches that. Sent in order and one at a time: a customer reading a split answer needs
      // the halves in the order they were written.
      for (const part of splitForChannel(body, TELEGRAM_MESSAGE_LIMIT)) {
        const res = await f(`${api}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: message.replyTo, text: part }),
        })
        if (!res.ok) {
          throw new Error(`telegram sendMessage failed with ${res.status}`)
        }
      }
    },

    verify({ headers }): boolean {
      // No configured secret means nothing to check. Returning true here is honest rather
      // than safe — the server refuses to mount an unverified channel, so the decision
      // lives there where it can be reported, not silently here.
      if (!opts.secretToken) return true
      const header = headers["x-telegram-bot-api-secret-token"]
      const value = Array.isArray(header) ? header[0] : header
      if (typeof value !== "string") return false
      // Constant time, like the WhatsApp and Discord adapters. `===` on strings stops at the
      // first differing byte, which makes the time it takes a function of how much of the secret
      // the caller already has — and this secret is all that stands between a stranger and a
      // business's conversation history.
      const presented = Buffer.from(value)
      const expected = Buffer.from(opts.secretToken)
      if (presented.length !== expected.length) return false
      return timingSafeEqual(presented, expected)
    },
  }
}
