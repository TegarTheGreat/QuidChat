import { ProviderError } from "@quidchat/core"
import { describe, expect, it } from "vitest"
import { asAnswer, openAiCompatible } from "./openai-compatible.js"

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
  choices: [{
    message: {
      content: JSON.stringify({
        segments: [{ text: "Warranty is 12 months.", kind: "business_claim", citations: ["k1"] }],
      }),
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
}

describe("openAiCompatible", () => {
  it("sends system, history and the current turn in that order", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })

    expect(records[0]!.url).toBe("https://example.test/v1/chat/completions")
    const messages = records[0]!.body.messages as { role: string; content: string }[]
    // The order is NOT a matter of taste: LLM caching is prefix-based, so stable
    // content must come first and volatile content last. Reversing this invalidates
    // the cache on every message with no error at all — exactly the regression that
    // mandatory test #3 in packages/core guards against.
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"])
    expect(messages[0]!.content).toBe("you are an assistant")
    expect(messages[1]!.content).toBe("hello")
    expect(messages[2]!.content).toContain("Customer question: warranty?")
  })

  it("parses the structured answer and reports token usage", async () => {
    const { impl } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const result = await p.complete({ model: "m", prompt })
    expect(result.answer!.segments).toHaveLength(1)
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
  })

  it("carries the key in the Authorization header", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "secret", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.headers.Authorization).toBe("Bearer secret")
  })

  it("maps HTTP status to the right ProviderError cause", async () => {
    const cases: [number, string][] = [
      [401, "auth"], [403, "auth"], [404, "unknown_model"],
      [429, "rate_limit"], [500, "unavailable"], [503, "unavailable"],
    ]
    for (const [status, cause] of cases) {
      const { impl } = fakeFetch({ status, json: { error: { message: "x" } } })
      const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
      await expectProviderError(p.complete({ model: "m", prompt }), cause as ProviderError["kind"])
    }
  })

  it("a non-JSON response becomes cause `schema`, not `unavailable`", async () => {
    // The distinction matters: `schema` records `schema_invalid` in escalations, and
    // that IS the correct signal that the model failed to comply with the format.
    // `unavailable` records something else.
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "maaf, bukan JSON" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await expectProviderError(p.complete({ model: "m", prompt }), "schema")
  })

  it("rejects JSON whose shape is not an Answer", async () => {
    const { impl } = fakeFetch({
      json: { choices: [{ message: { content: JSON.stringify({ not: "segments" }) } }] },
    })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await expectProviderError(p.complete({ model: "m", prompt }), "schema")
  })

  it("embed returns a vector from the embeddings endpoint", async () => {
    const { impl, records } = fakeFetch({ json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const v = await p.embed({ model: "e", text: "hello" })
    expect(v).toEqual([0.1, 0.2, 0.3])
    expect(records[0]!.url).toBe("https://example.test/v1/embeddings")
  })

  it("generateText returns the text verbatim, without parsing JSON", async () => {
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "how many months is the warranty" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const t = await p.generateText({ model: "m", system: "rewrite", user: "warranty?" })
    expect(t).toBe("how many months is the warranty")
  })

  it("a trailing slash on baseUrl does not produce a doubled URL", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1/", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.url).toBe("https://example.test/v1/chat/completions")
  })
})

describe("asAnswer", () => {
  const valid = {
    segments: [
      { text: "We are open daily.", kind: "general" },
      { text: "The warranty is one year.", kind: "business_claim", citations: ["c1"] },
    ],
  }

  it("passes a well-formed answer through", () => {
    expect(asAnswer(valid)).toBe(valid)
  })

  it("rejects every shape a model actually produces when it drifts", () => {
    // This is the gate between a model's raw output and the grounding validator. Everything here
    // is JSON a model has a real chance of returning, and none of it is an Answer.
    const cases: [string, unknown][] = [
      ["no segments at all", { answer: "one year" }],
      ["segments is not an array", { segments: "one year" }],
      ["a segment with no text", { segments: [{ kind: "general" }] }],
      ["text that is not a string", { segments: [{ kind: "general", text: 42 }] }],
      ["an invented kind", { segments: [{ kind: "fact", text: "one year" }] }],
      // The dangerous one: a claim about the business with nothing to check it against. Letting
      // it through would put an unsourced statement in front of a customer.
      ["a business_claim with no citations", { segments: [{ kind: "business_claim", text: "one year" }] }],
      ["citations that are not an array", { segments: [{ kind: "business_claim", text: "x", citations: "c1" }] }],
    ]
    for (const [label, value] of cases) {
      let thrown: unknown
      try {
        asAnswer(value)
      } catch (e) {
        thrown = e
      }
      expect(thrown, label).toBeInstanceOf(ProviderError)
      expect((thrown as ProviderError).kind, label).toBe("schema")
    }
  })
})
