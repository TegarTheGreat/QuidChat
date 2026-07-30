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
  it("mengirim system, history, dan turn sekarang dalam urutan itu", async () => {
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
    expect(messages[0]!.content).toBe("kamu asisten")
    expect(messages[1]!.content).toBe("halo")
    expect(messages[2]!.content).toContain("Pertanyaan pelanggan: garansi?")
  })

  it("mengurai jawaban terstruktur dan melaporkan pemakaian token", async () => {
    const { impl } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const result = await p.complete({ model: "m", prompt })
    expect(result.answer.segments).toHaveLength(1)
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
  })

  it("membawa kunci di header Authorization", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "secret", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.headers.Authorization).toBe("Bearer secret")
  })

  it("memetakan status HTTP ke sebab ProviderError yang benar", async () => {
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

  it("balasan yang bukan JSON menjadi sebab `schema`, bukan `unavailable`", async () => {
    // The distinction matters: `schema` records `schema_invalid` in escalations, and
    // that IS the correct signal that the model failed to comply with the format.
    // `unavailable` records something else.
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "maaf, bukan JSON" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("menolak JSON yang bentuknya bukan Answer", async () => {
    const { impl } = fakeFetch({
      json: { choices: [{ message: { content: JSON.stringify({ not: "segments" }) } }] },
    })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("embed mengembalikan vektor dari endpoint embeddings", async () => {
    const { impl, records } = fakeFetch({ json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const v = await p.embed({ model: "e", text: "halo" })
    expect(v).toEqual([0.1, 0.2, 0.3])
    expect(records[0]!.url).toBe("https://example.test/v1/embeddings")
  })

  it("generateText mengembalikan teks apa adanya, tanpa mengurai JSON", async () => {
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "garansi berapa bulan" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl: impl })
    const t = await p.generateText({ model: "m", system: "tulis ulang", user: "garansi?" })
    expect(t).toBe("garansi berapa bulan")
  })

  it("baseUrl bergaris miring di ujung tidak menghasilkan URL berganda", async () => {
    const { impl, records } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.test/v1/", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(records[0]!.url).toBe("https://example.test/v1/chat/completions")
  })
})
