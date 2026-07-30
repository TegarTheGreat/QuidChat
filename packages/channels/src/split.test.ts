import { describe, expect, it } from "vitest"
import { discordAdapter } from "./discord.js"
import { telegramAdapter } from "./telegram.js"
import { splitForChannel } from "./types.js"

/**
 * A grounded answer with its citations passes a few thousand characters easily, and every one of
 * these platforms rejects a message over its limit. The send failed and the customer got nothing,
 * after the answer had already been produced, recorded and paid for.
 */
describe("splitForChannel", () => {
  it("leaves a short message alone", () => {
    expect(splitForChannel("Open daily.", 100)).toEqual(["Open daily."])
  })

  it("never exceeds the limit", () => {
    const long = "word ".repeat(1000)
    for (const limit of [50, 200, 2000, 4096]) {
      for (const piece of splitForChannel(long, limit)) {
        expect(piece.length, `limit ${limit}`).toBeLessThanOrEqual(limit)
      }
    }
  })

  it("loses nothing", () => {
    const text = "First paragraph here.\n\nSecond paragraph, rather longer than the first one.\n\nThird."
    const joined = splitForChannel(text, 40).join(" ").replace(/\s+/g, " ")
    expect(joined).toBe(text.replace(/\s+/g, " "))
  })

  it("prefers a paragraph break to a sentence break to a word break", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}`
    // Cutting mid-sentence when a paragraph break was available makes the second message read
    // like a different thought.
    expect(splitForChannel(text, 40)).toEqual(["a".repeat(30), "b".repeat(30)])

    const sentences = `${"a".repeat(30)}. ${"b".repeat(30)}.`
    expect(splitForChannel(sentences, 40)[0]).toBe(`${"a".repeat(30)}.`)
  })

  it("splits inside a word only when one word is longer than the whole limit", () => {
    const monster = "x".repeat(90)
    const pieces = splitForChannel(monster, 40)
    expect(pieces).toHaveLength(3)
    expect(pieces.join("")).toBe(monster)
  })

  it("refuses a limit that could never be satisfied", () => {
    expect(() => splitForChannel("hello", 0)).toThrow(/positive/)
  })
})

describe("what each adapter actually sends", () => {
  const long = "Sentence about the warranty. ".repeat(300)

  it("sends a long answer to Telegram as several messages, in order", async () => {
    const sent: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).text as string)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const adapter = telegramAdapter({ tenantSlug: "shop", botToken: "t", fetchImpl })
    await adapter.send({ replyTo: "42", text: long, sources: ["Store Policy"] })

    // Before this the whole thing went in one request, Telegram rejected it, and the customer
    // got nothing at all — after the answer had been produced, recorded and paid for.
    expect(sent.length).toBeGreaterThan(1)
    for (const part of sent) expect(part.length).toBeLessThanOrEqual(4096)
    expect(sent.join(" ")).toContain("Store Policy")
  })

  it("splits harder for Discord, whose limit is less than half", async () => {
    const sent: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).content as string)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const adapter = discordAdapter({ tenantSlug: "shop", botToken: "b", fetchImpl })
    await adapter.send({ replyTo: "app:token", text: long, sources: [] })

    expect(sent.length).toBeGreaterThan(1)
    for (const part of sent) expect(part.length).toBeLessThanOrEqual(2000)
  })

  it("stops at the first failure rather than sending the rest into the dark", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response("{}", { status: 500 })
    }) as unknown as typeof fetch

    const adapter = telegramAdapter({ tenantSlug: "shop", botToken: "t", fetchImpl })
    await expect(
      adapter.send({ replyTo: "42", text: long, sources: [] }),
    ).rejects.toThrow(/telegram/)
    // One attempt, not one per piece: the caller logs a delivery failure, and hammering a
    // platform that just refused would only make it refuse harder.
    expect(calls).toBe(1)
  })
})
