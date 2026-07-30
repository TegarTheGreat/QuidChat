import { ProviderError } from "@quidchat/core"
import { describe, expect, it } from "vitest"
import { openAiCompatible } from "./openai-compatible.js"

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

// Prompt content is deliberately Indonesian: it represents real customer-facing
// business copy for the target market, not code.
const prompt = {
  system: "kamu asisten",
  history: [{ role: "user" as const, content: "halo" }],
  currentTurn: "<konteks>[k1] isi</konteks>\nPertanyaan pelanggan: garansi?",
}

const validAnswer = {
  choices: [{
    message: {
      content: JSON.stringify({
        segments: [{ text: "Garansi 12 bulan.", kind: "business_claim", citations: ["k1"] }],
      }),
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
}

describe("openAiCompatible", () => {
  it("sends system, history, and the current turn in that order", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })

    expect(records[0]!.url).toBe("https://example.test/v1/chat/completions")
    const messages = records[0]!.body.messages as { role: string; content: string }[]
    // This order is not a matter of taste: LLM caching is prefix-based, so stable
    // content must come first and volatile content last. Swapping any two of these
    // invalidates the cache on every message with no error at all — exactly the
    // regression the mandatory ordering test #3 in packages/core guards against.
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"])
    expect(messages[0]!.content).toBe("kamu asisten")
    expect(messages[1]!.content).toBe("halo")
    expect(messages[2]!.content).toContain("Pertanyaan pelanggan: garansi?")
  })

  it("parses a structured answer and reports token usage", async () => {
    const { impl } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const result = await p.complete({ model: "m", prompt })
    expect(result.answer.segments).toHaveLength(1)
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
  })

  it("carries the key in the Authorization header", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "secret", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.headers.Authorization).toBe("Bearer secret")
  })

  it("maps HTTP status codes to the correct ProviderError cause", async () => {
    const cases: [number, string][] = [
      [401, "auth"], [403, "auth"], [404, "unknown_model"],
      [429, "rate_limit"], [500, "unavailable"], [503, "unavailable"],
    ]
    for (const [status, cause] of cases) {
      const { impl } = fakeFetch({ status, json: { error: { message: "x" } } })
      const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
      await expect(p.complete({ model: "m", prompt })).rejects.toThrow(ProviderError)
      await p.complete({ model: "m", prompt }).catch((e: unknown) => {
        expect((e as ProviderError).kind).toBe(cause)
      })
    }
  })

  it("a non-JSON response becomes cause `schema`, not `unavailable`", async () => {
    // The distinction matters: `schema` records `schema_invalid` in escalations,
    // which correctly signals that the model failed to follow the format.
    // `unavailable` would record something else entirely.
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "maaf, bukan JSON" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("rejects JSON whose shape is not an Answer", async () => {
    const { impl } = fakeFetch({
      json: { choices: [{ message: { content: JSON.stringify({ not: "segments" }) } }] },
    })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("embed returns the vector from the embeddings endpoint", async () => {
    const { impl, records } = fakeFetch({ json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const v = await p.embed({ model: "e", text: "halo" })
    expect(v).toEqual([0.1, 0.2, 0.3])
    expect(records[0]!.url).toBe("https://example.test/v1/embeddings")
  })

  it("generateText returns the text as-is, without parsing JSON", async () => {
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "garansi berapa bulan" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const t = await p.generateText({ model: "m", system: "tulis ulang", user: "garansi?" })
    expect(t).toBe("garansi berapa bulan")
  })

  it("a trailing slash in baseUrl does not produce a doubled-up URL", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1/", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.url).toBe("https://example.test/v1/chat/completions")
  })
})
