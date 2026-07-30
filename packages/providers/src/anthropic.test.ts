import { ProviderError } from "@quidchat/core"
import { describe, expect, it } from "vitest"
import { anthropic } from "./anthropic.js"

/**
 * Asserts that a call fails with a particular `ProviderError` kind.
 *
 * The tests here used to be written as `await call().catch((e) => expect(...))`, which asserts
 * NOTHING when the call succeeds: the callback never runs, no expectation is registered, and the
 * test passes. Gutting `asAnswer` to accept any shape left all of them green, which is how this
 * was found. Awaiting the rejection is what makes the assertion mandatory.
 */
async function expectProviderError(call: Promise<unknown>, kind: ProviderError["kind"]): Promise<ProviderError> {
  const error = await call.then(
    () => null,
    (e: unknown) => e as ProviderError,
  )
  expect(error, `expected a ProviderError with kind ${kind}, but the call resolved`).toBeInstanceOf(
    ProviderError,
  )
  expect(error!.kind).toBe(kind)
  return error!
}


type RequestRecord = { url: string; body: Record<string, unknown>; headers: Record<string, string> }

function fakeFetch(reply: { status?: number; json?: unknown; body?: string }) {
  const records: RequestRecord[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    records.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const status = reply.status ?? 200
    const text = reply.body ?? JSON.stringify(reply.json ?? {})
    return new Response(text, { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { impl, records }
}

const prompt = {
  system: "you are an assistant",
  history: [{ role: "user" as const, content: "hello" }],
  currentTurn: "<context>[k1] content</context>\nCustomer question: warranty?",
}

const validAnswer = {
  content: [{
    type: "text",
    text: JSON.stringify({
      segments: [{ text: "Warranty is 12 months.", kind: "business_claim", citations: ["k1"] }],
    }),
  }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
}

describe("anthropic", () => {
  it("posts to {baseUrl}/messages", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.url).toBe("https://example.test/v1/messages")
  })

  it("uses x-api-key and anthropic-version headers, NOT Authorization: Bearer", async () => {
    // Copying the OpenAI-compatible header shape is the obvious mistake this
    // adapter exists to avoid — assert it explicitly.
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "secret", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    const headers = records[0]!.headers
    expect(headers["x-api-key"]).toBe("secret")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers.Authorization).toBeUndefined()
  })

  it("defaults baseUrl to https://api.anthropic.com/v1", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = anthropic({ id: "test", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.url).toBe("https://api.anthropic.com/v1/messages")
  })

  it("sends system as a block array with ephemeral cache_control on the last block", async () => {
    // This IS the cache breakpoint. Without this test, caching can silently
    // disappear with no error and no log — only the bill would show it.
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    const system = records[0]!.body.system as { type: string; text: string; cache_control?: unknown }[]
    expect(system).toHaveLength(1)
    expect(system[0]!.text).toBe("you are an assistant")
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" })
  })

  it("messages carry history then currentTurn, and do NOT carry system", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    const messages = records[0]!.body.messages as { role: string; content: string }[]
    expect(messages.map((m) => m.role)).toEqual(["user", "user"])
    expect(messages[0]!.content).toBe("hello")
    expect(messages[1]!.content).toContain("Customer question: warranty?")
    expect(messages.some((m) => (m as { role: string }).role === "system")).toBe(false)
  })

  it("parses the answer from content[0].text and reports usage including cachedTokens", async () => {
    const { impl } = fakeFetch({ json: validAnswer })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const result = await p.complete({ model: "m", prompt })
    expect(result.answer.segments).toHaveLength(1)
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
    expect(result.usage.cachedTokens).toBe(80)
  })

  it("maps HTTP status to the same ProviderError cause as the OpenAI-compatible adapter", async () => {
    const cases: [number, string][] = [
      [401, "auth"], [403, "auth"], [404, "unknown_model"],
      [429, "rate_limit"], [500, "unavailable"], [503, "unavailable"],
    ]
    for (const [status, cause] of cases) {
      const { impl } = fakeFetch({ status, json: { error: { message: "x" } } })
      const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
      await expectProviderError(p.complete({ model: "m", prompt }), cause as ProviderError["kind"])
    }
  })

  it("a throwing fetch becomes cause `unavailable`", async () => {
    const impl = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await expectProviderError(p.complete({ model: "m", prompt }), "unavailable")
  })

  it("a response that cannot be mapped to an Answer becomes cause `schema`", async () => {
    const { impl } = fakeFetch({
      json: { content: [{ type: "text", text: JSON.stringify({ not: "segments" }) }], usage: {} },
    })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await expectProviderError(p.complete({ model: "m", prompt }), "schema")
  })

  it("embed throws ProviderError unknown_model naming composite()", async () => {
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k" })
    const error = await expectProviderError(p.embed({ model: "e", text: "hello" }), "unknown_model")
    expect(error.message).toContain("embeddings")
    expect(error.message).toContain("composite()")
  })

  it("capabilities reports promptCaching, unlike the OpenAI-compatible adapter", async () => {
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k" })
    const caps = await p.capabilities("m")
    expect(caps.promptCaching).toEqual({ minPrefixTokens: 1024, maxBreakpoints: 4 })
  })

  it("generateText returns the text verbatim from content[0].text", async () => {
    const { impl } = fakeFetch({ json: { content: [{ type: "text", text: "how many months is the warranty" }], usage: {} } })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const t = await p.generateText({ model: "m", system: "tulis ulang", user: "warranty?" })
    expect(t).toBe("how many months is the warranty")
  })

  it("a trailing slash on baseUrl does not produce a doubled URL", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = anthropic({ id: "test", baseUrl: "https://example.test/v1/", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.url).toBe("https://example.test/v1/messages")
  })
})
