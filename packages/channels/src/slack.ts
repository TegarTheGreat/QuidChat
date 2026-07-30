import { createHmac, timingSafeEqual } from "node:crypto"
import {
  renderForChannel,
  splitForChannel,
  type ChannelAdapter,
  type IncomingMessage,
} from "./types.js"

/**
 * Slack, through the Events API.
 *
 * Verification follows docs.slack.dev/authentication/verifying-requests-from-slack exactly: the
 * signature is `v0=` plus a hex HMAC-SHA256 over `v0:{timestamp}:{body}`, keyed with the signing
 * secret. The timestamp is part of the signed material AND checked against the clock, which is
 * what makes a captured request useless five minutes later — a signature alone would otherwise
 * be replayable forever.
 *
 * Slack sends far more than customer messages to the same endpoint: joins, leaves, edits,
 * reactions, and the bot's own posts. Answering the bot's own message makes the assistant talk to
 * itself in a loop that bills for every turn, which is why `bot_id` and `subtype` are checked
 * before anything else.
 */

/** Slack's own recommendation, and the window a captured request stays useful for. */
const REPLAY_WINDOW_SECONDS = 300

/** Slack accepts far more, but recommends staying near this for readability. */
const SLACK_MESSAGE_LIMIT = 3900

export function slackAdapter(opts: {
  tenantSlug: string
  /** Bot token, `xoxb-…`, used for `chat.postMessage`. */
  botToken: string
  /** Signing secret from the app's Basic Information page. Strongly recommended. */
  signingSecret?: string
  fetchImpl?: typeof fetch
  /** Injected so a test can place a request inside or outside the replay window. */
  now?: () => number
}): ChannelAdapter {
  const f = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now())

  return {
    id: "slack",

    parse(body: unknown): IncomingMessage | null {
      const payload = body as {
        type?: unknown
        event?: {
          type?: unknown
          subtype?: unknown
          bot_id?: unknown
          text?: unknown
          user?: unknown
          channel?: unknown
        }
      }
      // `url_verification` is the handshake, handled by the caller like Discord's PING.
      if (payload.type !== "event_callback") return null

      const event = payload.event
      if (!event) return null
      // A bot's own message coming back would make the assistant answer itself.
      if (event.bot_id !== undefined) return null
      // Joins, leaves, edits and deletions all arrive as `message` with a subtype.
      if (event.subtype !== undefined) return null
      if (event.type !== "message" && event.type !== "app_mention") return null

      const text = event.text
      const user = event.user
      const channel = event.channel
      if (typeof text !== "string" || text.trim() === "") return null
      if (typeof user !== "string" || typeof channel !== "string") return null

      return {
        tenantSlug: opts.tenantSlug,
        // The person, not the channel: a shared channel is one place but many customers.
        visitorId: `slack:${user}`,
        text,
        replyTo: channel,
      }
    },

    async send(message): Promise<void> {
      const body = renderForChannel({
        segments: [{ text: message.text, kind: "general" }],
        sources: message.sources,
      })
      for (const part of splitForChannel(body, SLACK_MESSAGE_LIMIT)) {
        const res = await f("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.botToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ channel: message.replyTo, text: part }),
        })
        if (!res.ok) throw new Error(`slack chat.postMessage failed with ${res.status}`)
        // Slack answers 200 with `{ok: false, error: "..."}` for an invalid token or a channel
        // the bot is not in. Treating that as success would lose the reply silently.
        const answer = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (answer?.ok !== true) {
          throw new Error(`slack chat.postMessage refused: ${answer?.error ?? "unknown error"}`)
        }
      }
    },

    verify({ body, headers }): boolean {
      if (!opts.signingSecret) return true

      const signature = single(headers["x-slack-signature"])
      const timestamp = single(headers["x-slack-request-timestamp"])
      if (typeof signature !== "string" || typeof timestamp !== "string") return false

      // Checked before the HMAC: a captured request carries a valid signature forever, and the
      // timestamp is the only thing that stops it being replayed.
      const age = Math.abs(now() / 1000 - Number(timestamp))
      if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) return false

      const expected = `v0=${createHmac("sha256", opts.signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`
      const presented = Buffer.from(signature)
      const computed = Buffer.from(expected)
      if (presented.length !== computed.length) return false
      return timingSafeEqual(presented, computed)
    },
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Slack disables an endpoint that does not echo this challenge, exactly like Discord's PING. */
export function slackChallenge(body: unknown): string | null {
  const payload = body as { type?: unknown; challenge?: unknown }
  return payload.type === "url_verification" && typeof payload.challenge === "string"
    ? payload.challenge
    : null
}
