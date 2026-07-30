import { createHmac, timingSafeEqual } from "node:crypto"
import { renderForChannel, type ChannelAdapter, type IncomingMessage } from "./types.js"

/**
 * WhatsApp Cloud API (Meta).
 *
 * Webhook bodies are deeply nested: `entry[].changes[].value.messages[]`. Most deliveries
 * are status updates — sent, delivered, read — which arrive on the same endpoint and are
 * not customer messages.
 *
 * Verification uses `X-Hub-Signature-256`, an HMAC of the raw body with the app secret.
 * The comparison is constant-time: a plain `===` on an HMAC leaks how many leading bytes
 * matched, which is enough to forge a signature byte by byte.
 */
export function whatsappCloudAdapter(opts: {
  tenantSlug: string
  /** Phone number id from the WhatsApp Business account. */
  phoneNumberId: string
  accessToken: string
  /** App secret, used for signature verification. Strongly recommended. */
  appSecret?: string
  fetchImpl?: typeof fetch
}): ChannelAdapter {
  const f = opts.fetchImpl ?? fetch
  const api = `https://graph.facebook.com/v21.0/${opts.phoneNumberId}/messages`

  return {
    id: "whatsapp",

    parse(body: unknown): IncomingMessage | null {
      const payload = body as {
        entry?: {
          changes?: {
            value?: {
              messages?: { from?: unknown; type?: unknown; text?: { body?: unknown } }[]
            }
          }[]
        }[]
      }
      const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      if (!message) return null
      // Images, audio, stickers and location all arrive here. Only text is answerable
      // today; anything else returns null rather than an empty question.
      if (message.type !== "text") return null

      const text = message.text?.body
      const from = message.from
      if (typeof text !== "string" || text.trim() === "" || typeof from !== "string") {
        return null
      }

      return {
        tenantSlug: opts.tenantSlug,
        visitorId: `whatsapp:${from}`,
        text,
        replyTo: from,
      }
    },

    async send(message): Promise<void> {
      const res = await f(api, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: message.replyTo,
          type: "text",
          text: {
            body: renderForChannel({
              segments: [{ text: message.text, kind: "general" }],
              sources: message.sources,
            }),
          },
        }),
      })
      if (!res.ok) {
        throw new Error(`whatsapp send failed with ${res.status}`)
      }
    },

    verify({ body, headers }): boolean {
      if (!opts.appSecret) return true
      const header = headers["x-hub-signature-256"]
      const provided = Array.isArray(header) ? header[0] : header
      if (typeof provided !== "string" || !provided.startsWith("sha256=")) return false

      const expected = `sha256=${createHmac("sha256", opts.appSecret).update(body).digest("hex")}`
      const a = Buffer.from(provided)
      const b = Buffer.from(expected)
      // Length must match before timingSafeEqual, which throws on unequal lengths — and
      // the length itself is not a secret.
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    },
  }
}

/**
 * WAHA — a self-hosted WhatsApp HTTP API, and the option most small businesses reach for
 * because it needs no Meta business verification.
 *
 * Its webhook is flat: `{ event, payload: { from, body, fromMe } }`. The `fromMe` flag is
 * the important one: WAHA echoes the bot's own outgoing messages back, and answering
 * those makes the assistant talk to itself in a loop that bills every turn.
 */
export function wahaAdapter(opts: {
  tenantSlug: string
  /** Base URL of the WAHA instance, e.g. http://localhost:3000 */
  baseUrl: string
  session?: string
  apiKey?: string
  fetchImpl?: typeof fetch
}): ChannelAdapter {
  const f = opts.fetchImpl ?? fetch
  const base = opts.baseUrl.replace(/\/+$/, "")
  const session = opts.session ?? "default"

  return {
    id: "waha",

    parse(body: unknown): IncomingMessage | null {
      const event = body as {
        event?: unknown
        payload?: { from?: unknown; body?: unknown; fromMe?: unknown }
      }
      if (event.event !== "message") return null

      const payload = event.payload
      if (!payload || payload.fromMe === true) return null

      const from = payload.from
      const text = payload.body
      if (typeof from !== "string" || typeof text !== "string" || text.trim() === "") {
        return null
      }

      return {
        tenantSlug: opts.tenantSlug,
        visitorId: `waha:${from}`,
        text,
        replyTo: from,
      }
    },

    async send(message): Promise<void> {
      const res = await f(`${base}/api/sendText`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
        },
        body: JSON.stringify({
          session,
          chatId: message.replyTo,
          text: renderForChannel({
            segments: [{ text: message.text, kind: "general" }],
            sources: message.sources,
          }),
        }),
      })
      if (!res.ok) {
        throw new Error(`waha sendText failed with ${res.status}`)
      }
    },

    verify({ headers }): boolean {
      if (!opts.apiKey) return true
      const header = headers["x-api-key"]
      const value = Array.isArray(header) ? header[0] : header
      return value === opts.apiKey
    },
  }
}
