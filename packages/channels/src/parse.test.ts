import { describe, expect, it, vi } from "vitest"
import { discordAdapter, isDiscordPing } from "./discord.js"
import { handleChannelMessage } from "./handle.js"
import { telegramAdapter } from "./telegram.js"
import { wahaAdapter, whatsappCloudAdapter } from "./whatsapp.js"

/**
 * What each platform sends, and what the adapters make of it.
 *
 * The cases that matter are the ones that must produce NOTHING. Every one of these platforms
 * delivers far more than customer questions to the same endpoint — delivery receipts, typing
 * indicators, edits, and the bot's own outgoing messages echoed back. Answering an echo makes the
 * assistant talk to itself, and it bills for every turn of the loop.
 */

const telegram = telegramAdapter({ tenantSlug: "shop", botToken: "123:abc" })
const whatsapp = whatsappCloudAdapter({
  tenantSlug: "shop",
  phoneNumberId: "555",
  accessToken: "token",
})
const waha = wahaAdapter({ tenantSlug: "shop", baseUrl: "http://waha.internal" })
const discord = discordAdapter({ tenantSlug: "shop", botToken: "bot" })

describe("telegram parsing", () => {
  it("reads a customer's message", () => {
    const incoming = telegram.parse({
      message: { message_id: 9, chat: { id: 42 }, from: { id: 7, is_bot: false }, text: "hours?" },
    }, {})
    expect(incoming).toEqual({
      tenantSlug: "shop",
      // The person, not the chat: in a group the chat is shared and the customer is not.
      visitorId: "telegram:7",
      text: "hours?",
      replyTo: "42",
    })
  })

  it("ignores everything that is not a person's text", () => {
    for (const body of [
      {},
      { edited_message: { chat: { id: 1 }, from: { id: 2 }, text: "changed" } },
      { channel_post: { chat: { id: 1 }, text: "posted" } },
      { message: { chat: { id: 1 }, from: { id: 2 } } },
      { message: { chat: { id: 1 }, from: { id: 2 }, text: "   " } },
      { message: { chat: { id: 1 }, from: { id: 2 }, photo: [] } },
      // The bot's own message coming back. Answering it makes the assistant answer itself.
      { message: { chat: { id: 1 }, from: { id: 2, is_bot: true }, text: "I said this" } },
      { message: { from: { id: 2 }, text: "no chat" } },
      { message: { chat: { id: 1 }, text: "no sender" } },
    ]) {
      expect(telegram.parse(body, {}), JSON.stringify(body)).toBeNull()
    }
  })
})

/** One inbound message in the shape Meta's Cloud API delivers it. */
function message(extra: Record<string, unknown>) {
  return { entry: [{ changes: [{ value: { messages: [{ from: "628123", ...extra }] } }] }] }
}

describe("whatsapp cloud parsing", () => {
  it("reads a customer's message", () => {
    expect(whatsapp.parse(message({ type: "text", text: { body: "hours?" } }), {})).toEqual({
      tenantSlug: "shop",
      visitorId: "whatsapp:628123",
      text: "hours?",
      replyTo: "628123",
    })
  })

  it("ignores status callbacks and everything that is not text", () => {
    for (const body of [
      {},
      // Delivery and read receipts arrive constantly on a busy number.
      { entry: [{ changes: [{ value: { statuses: [{ status: "delivered" }] } }] }] },
      message({ type: "image", image: { id: "1" } }),
      message({ type: "audio", audio: { id: "1" } }),
      message({ type: "text", text: { body: "  " } }),
      message({ type: "text" }),
    ]) {
      expect(whatsapp.parse(body, {}), JSON.stringify(body)).toBeNull()
    }
  })
})

describe("waha parsing", () => {
  it("reads a customer's message", () => {
    expect(
      waha.parse({ event: "message", payload: { from: "628123@c.us", body: "hours?" } }, {}),
    ).toEqual({
      tenantSlug: "shop",
      visitorId: "waha:628123@c.us",
      text: "hours?",
      replyTo: "628123@c.us",
    })
  })

  it("ignores its own echo and other events", () => {
    for (const body of [
      { event: "session.status", payload: { status: "WORKING" } },
      // WAHA echoes the bot's outgoing messages back to the same webhook.
      { event: "message", payload: { from: "628123@c.us", body: "our answer", fromMe: true } },
      { event: "message", payload: { from: "628123@c.us", body: "" } },
      { event: "message", payload: { body: "no sender" } },
      { event: "message" },
    ]) {
      expect(waha.parse(body, {}), JSON.stringify(body)).toBeNull()
    }
  })
})

/** A slash-command interaction, which is the only shape Discord sends that is a question. */
function interaction(extra: Record<string, unknown>) {
  return {
    type: 2,
    token: "interaction-token",
    application_id: "app-1",
    data: { options: [{ name: "question", value: "hours?" }] },
    ...extra,
  }
}

describe("discord parsing", () => {
  it("reads a slash command, in a guild and in a direct message", () => {
    expect(interaction({ member: { user: { id: "u1" } } })).toBeTruthy()
    expect(discord.parse(interaction({ member: { user: { id: "u1" } } }), {})).toEqual({
      tenantSlug: "shop",
      visitorId: "discord:u1",
      text: "hours?",
      // A follow-up is addressed to the interaction token, which is short lived — which is why
      // the reply has to be sent promptly rather than queued.
      replyTo: "app-1:interaction-token",
    })
    expect(discord.parse(interaction({ user: { id: "u2" } }), {})?.visitorId).toBe("discord:u2")
  })

  it("ignores a ping and anything that is not a command with a question", () => {
    for (const body of [
      { type: 1 },
      interaction({ type: 1, member: { user: { id: "u1" } } }),
      { ...interaction({ member: { user: { id: "u1" } } }), data: { options: [] } },
      { ...interaction({ member: { user: { id: "u1" } } }), data: { options: [{ name: "other", value: "x" }] } },
      { ...interaction({ member: { user: { id: "u1" } } }), token: undefined },
      interaction({}),
    ]) {
      expect(discord.parse(body, {}), JSON.stringify(body)).toBeNull()
    }
  })

  it("recognises the handshake Discord disables an endpoint for failing", () => {
    expect(isDiscordPing({ type: 1 })).toBe(true)
    expect(isDiscordPing({ type: 2 })).toBe(false)
    expect(isDiscordPing({})).toBe(false)
  })
})

/** An adapter that always parses a customer message, so a test can vary only what it means to. */
function adapter(over: Partial<ReturnType<typeof telegramAdapter>> = {}) {
  return {
    id: "telegram",
    parse: () => ({ tenantSlug: "shop", visitorId: "v1", text: "hours?", replyTo: "42" }),
    send: vi.fn(async () => {}),
    ...over,
  }
}

describe("handling one inbound message", () => {
  it("verifies before it parses, so a forged body never reaches the pipeline", async () => {
    const parse = vi.fn(() => null)
    const answer = vi.fn()
    const result = await handleChannelMessage({
      adapter: { id: "telegram", parse, send: async () => {}, verify: () => false },
      rawBody: JSON.stringify({ anything: true }),
      headers: {},
      answer,
      logError: () => {},
    })

    expect(result).toEqual({ status: "rejected", sent: false, why: "signature verification failed" })
    // Neither ran. A forged request must not reach the pipeline even to be refused: it would be
    // recorded in a business's history and billed for.
    expect(parse).not.toHaveBeenCalled()
    expect(answer).not.toHaveBeenCalled()

    // And the ordering is verification FIRST, not merely verification before the adapter's own
    // parse. An unverified body that is not JSON has to come back as a signature failure: any
    // other answer tells a stranger their payload was read before it was rejected.
    const malformed = await handleChannelMessage({
      adapter: { id: "telegram", parse, send: async () => {}, verify: () => false },
      rawBody: "{ not json",
      headers: {},
      answer,
      logError: () => {},
    })
    // Narrowed rather than read off the union: only the two non-delivering outcomes carry a
    // reason, and this must be the rejected one.
    expect(malformed).toEqual({ status: "rejected", sent: false, why: "signature verification failed" })
  })

  it("treats uninteresting traffic as ignored rather than as an error", async () => {
    const result = await handleChannelMessage({
      adapter: { id: "telegram", parse: () => null, send: async () => {} },
      rawBody: JSON.stringify({ edited_message: {} }),
      headers: {},
      answer: async () => ({ kind: "refused", text: "no", reason: "no_source" }),
      logError: () => {},
    })
    // Receipts and echoes are valid traffic. Logging them as errors would bury the failures that
    // matter under the ones that do not.
    expect(result.status).toBe("ignored")
  })

  it("rejects a body that is not JSON", async () => {
    const result = await handleChannelMessage({
      adapter: adapter(),
      rawBody: "not json at all",
      headers: {},
      answer: async () => ({ kind: "refused", text: "no", reason: "no_source" }),
      logError: () => {},
    })
    expect(result.status).toBe("rejected")
  })

  it("sends an answer with its sources, and a refusal without them", async () => {
    const sent: { text: string }[] = []
    const send = async (outgoing: { text: string }) => {
      sent.push(outgoing)
    }

    await handleChannelMessage({
      adapter: { ...adapter(), send },
      rawBody: "{}",
      headers: {},
      answer: async () => ({
        kind: "answered",
        segments: [{ text: "One year.", kind: "business_claim" }],
        citations: [{ chunkId: "c1", documentTitle: "Store Policy" }],
      }),
      logError: () => {},
    })
    expect(sent[0]!.text).toContain("One year.")
    expect(sent[0]!.text).toContain("Store Policy")

    await handleChannelMessage({
      adapter: { ...adapter(), send },
      rawBody: "{}",
      headers: {},
      answer: async () => ({ kind: "refused", text: "Sorry, I cannot help with that.", reason: "no_source" }),
      logError: () => {},
    })
    // A refusal is the assistant's own words. Attaching a source to it would claim a document
    // said something it did not.
    expect(sent[1]!.text).toBe("Sorry, I cannot help with that.")
  })

  it("logs a delivery failure instead of throwing it back at the platform", async () => {
    const logged: string[] = []
    const result = await handleChannelMessage({
      adapter: {
        ...adapter(),
        send: async () => {
          throw new Error("telegram is down")
        },
      },
      rawBody: "{}",
      headers: {},
      answer: async () => ({ kind: "refused", text: "no", reason: "no_source" }),
      logError: (line) => logged.push(line),
    })

    // The answer was produced and recorded; only delivery failed. Throwing would make the
    // platform retry a webhook that already did its work, answering and billing twice.
    expect(result.status).toBe("refused")
    expect(logged.join(" ")).toMatch(/delivery failed/)
  })

  it("removes a NUL byte before the text reaches the pipeline", async () => {
    let seen = ""
    await handleChannelMessage({
      adapter: {
        id: "telegram",
        parse: () => ({ tenantSlug: "shop", visitorId: "v1", text: "hours ?", replyTo: "42" }),
        send: async () => {},
      },
      rawBody: "{}",
      headers: {},
      answer: async (incoming) => {
        seen = incoming.text
        return { kind: "refused", text: "no", reason: "no_source" }
      },
      logError: () => {},
    })
    // Postgres will not store it, and here the failure would land after the platform had already
    // been told the webhook succeeded — leaving a customer waiting for nothing.
    expect(seen).toBe("hours?")
  })
})
