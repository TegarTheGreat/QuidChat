import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { lineAdapter } from "./line.js"
import { slackAdapter, slackChallenge } from "./slack.js"

const SIGNING_SECRET = "slack-signing-secret"
const CHANNEL_SECRET = "line-channel-secret"
const NOW = 1_700_000_000_000

/** Slack's scheme, from docs.slack.dev: v0= plus a hex HMAC over `v0:{timestamp}:{body}`. */
function slackSignature(body: string, timestamp: string, secret = SIGNING_SECRET) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`
}

describe("slack", () => {
  const adapter = slackAdapter({
    tenantSlug: "shop",
    botToken: "xoxb-token",
    signingSecret: SIGNING_SECRET,
    now: () => NOW,
  })
  const body = JSON.stringify({ type: "event_callback", event: { type: "message" } })
  const timestamp = String(Math.floor(NOW / 1000))

  it("accepts a signature over the timestamp and body together", () => {
    expect(
      adapter.verify!({
        body,
        headers: {
          "x-slack-signature": slackSignature(body, timestamp),
          "x-slack-request-timestamp": timestamp,
        },
      }),
    ).toBe(true)
  })

  it("refuses a captured request replayed later", () => {
    // A signature alone is valid forever. The timestamp is both signed AND checked against the
    // clock, which is the only thing that makes a captured request useless.
    const old = String(Math.floor(NOW / 1000) - 600)
    expect(
      adapter.verify!({
        body,
        headers: {
          "x-slack-signature": slackSignature(body, old),
          "x-slack-request-timestamp": old,
        },
      }),
    ).toBe(false)
  })

  it("refuses a wrong secret, a missing header and a tampered body", () => {
    for (const headers of [
      { "x-slack-signature": slackSignature(body, timestamp, "wrong"), "x-slack-request-timestamp": timestamp },
      { "x-slack-request-timestamp": timestamp },
      { "x-slack-signature": slackSignature(body, timestamp) },
      {},
    ]) {
      expect(adapter.verify!({ body, headers }), JSON.stringify(headers)).toBe(false)
    }
    expect(
      adapter.verify!({
        body: `${body} `,
        headers: {
          "x-slack-signature": slackSignature(body, timestamp),
          "x-slack-request-timestamp": timestamp,
        },
      }),
    ).toBe(false)
  })

  it("reads a customer message and ignores everything Slack also sends", () => {
    expect(
      adapter.parse(
        { type: "event_callback", event: { type: "message", text: "hours?", user: "U1", channel: "C1" } },
        {},
      ),
    ).toEqual({ tenantSlug: "shop", visitorId: "slack:U1", text: "hours?", replyTo: "C1" })

    for (const ignored of [
      { type: "url_verification", challenge: "abc" },
      // The bot's own post. Answering it makes the assistant talk to itself and bill every turn.
      { type: "event_callback", event: { type: "message", text: "we said this", bot_id: "B1", user: "U1", channel: "C1" } },
      // Joins, leaves, edits and deletions all arrive as `message` with a subtype.
      { type: "event_callback", event: { type: "message", subtype: "channel_join", text: "joined", user: "U1", channel: "C1" } },
      { type: "event_callback", event: { type: "reaction_added", user: "U1", channel: "C1" } },
      { type: "event_callback", event: { type: "message", text: "  ", user: "U1", channel: "C1" } },
    ]) {
      expect(adapter.parse(ignored, {}), JSON.stringify(ignored)).toBeNull()
    }
  })

  it("recognises the handshake Slack disables an endpoint for failing", () => {
    expect(slackChallenge({ type: "url_verification", challenge: "abc" })).toBe("abc")
    expect(slackChallenge({ type: "event_callback" })).toBeNull()
  })

  it("treats a 200 with ok:false as the failure it is", async () => {
    // Slack answers 200 with {ok:false,error:"channel_not_found"} for a channel the bot is not in.
    // Reading only the status would lose the reply silently.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 }),
    ) as unknown as typeof fetch
    const failing = slackAdapter({ tenantSlug: "shop", botToken: "t", fetchImpl })

    await expect(
      failing.send({ replyTo: "C1", text: "hello", sources: [] }),
    ).rejects.toThrow(/not_in_channel/)
  })
})

describe("line", () => {
  const adapter = lineAdapter({
    tenantSlug: "shop",
    accessToken: "line-token",
    channelSecret: CHANNEL_SECRET,
  })
  const body = JSON.stringify({ events: [] })
  const signature = createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64")

  it("verifies a Base64 HMAC over the body", () => {
    expect(adapter.verify!({ body, headers: { "x-line-signature": signature } })).toBe(true)
  })

  it("refuses the hex form of the same digest", () => {
    // The detail that quietly breaks an implementation copied from a platform that uses hex: it
    // verifies nothing and rejects everything, which reads as a configuration problem.
    const hex = createHmac("sha256", CHANNEL_SECRET).update(body).digest("hex")
    expect(adapter.verify!({ body, headers: { "x-line-signature": hex } })).toBe(false)
  })

  it("refuses a tampered body and a missing header", () => {
    expect(adapter.verify!({ body: `${body} `, headers: { "x-line-signature": signature } })).toBe(false)
    expect(adapter.verify!({ body, headers: {} })).toBe(false)
  })

  it("reads the first customer text and ignores the rest of what LINE batches", () => {
    const incoming = adapter.parse(
      {
        events: [
          { type: "follow", replyToken: "r0", source: { userId: "U9" } },
          { type: "message", replyToken: "r1", message: { type: "sticker" }, source: { userId: "U1" } },
          { type: "message", replyToken: "r2", message: { type: "text", text: "hours?" }, source: { userId: "U1" } },
        ],
      },
      {},
    )
    // The reply token belongs to one event, which is why only one is answered.
    expect(incoming).toEqual({
      tenantSlug: "shop",
      visitorId: "line:U1",
      text: "hours?",
      replyTo: "r2",
    })

    for (const ignored of [
      { events: [] },
      { events: [{ type: "follow", replyToken: "r", source: { userId: "U1" } }] },
      { events: [{ type: "message", replyToken: "r", message: { type: "image" }, source: { userId: "U1" } }] },
      // Without a reply token there is nowhere to answer.
      { events: [{ type: "message", message: { type: "text", text: "hi" }, source: { userId: "U1" } }] },
    ]) {
      expect(adapter.parse(ignored, {}), JSON.stringify(ignored)).toBeNull()
    }
  })

  it("sends every piece in one request, because the reply token is single-use", async () => {
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(init.body as string)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const sender = lineAdapter({ tenantSlug: "shop", accessToken: "t", fetchImpl })

    await sender.send({ replyTo: "token", text: "x".repeat(12_000), sources: [] })

    // One request. A second would fail: the token is spent.
    expect(bodies).toHaveLength(1)
    const sent = JSON.parse(bodies[0]!) as { messages: { text: string }[] }
    expect(sent.messages.length).toBeGreaterThan(1)
    expect(sent.messages.length).toBeLessThanOrEqual(5)
    for (const m of sent.messages) expect(m.text.length).toBeLessThanOrEqual(5000)
  })
})
