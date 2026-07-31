import { describe, expect, it, vi } from "vitest"
import { ModelListError, listModels } from "./models.js"

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch
}

describe("asking a service what it offers", () => {
  it("returns the ids, deduplicated and sorted", () => {
    // Sorted because a list in whatever order a vendor serves is one an owner reads twice.
    return expect(
      listModels(
        { OPENAI_API_KEY: "sk-x" },
        respond({ data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "gpt-4o" }] }),
      ),
    ).resolves.toEqual(["gpt-4o", "text-embedding-3-small"])
  })

  it("sends the credential the way that service expects it", async () => {
    const openai = respond({ data: [] })
    await listModels({ OPENAI_API_KEY: "sk-x" }, openai)
    const openaiInit = (openai as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]
    expect((openaiInit.headers as Record<string, string>).authorization).toBe("Bearer sk-x")

    // Anthropic takes a different header and a version — a bearer token there is a 401 that
    // reads as a bad key rather than as the wrong shape of request.
    const anthropic = respond({ data: [] })
    await listModels({ ANTHROPIC_API_KEY: "sk-ant" }, anthropic)
    const anthropicInit = (anthropic as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]
    const headers = anthropicInit.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("sk-ant")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("asks a local runner at its own address, with no key", async () => {
    const ollama = respond({ data: [{ id: "llama3.2" }] })
    await listModels({ OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" }, ollama)
    const [url, init] = (ollama as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toBe("http://127.0.0.1:11434/v1/models")
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it("says a key was rejected rather than reporting no models", async () => {
    // "The key is wrong" and "the service is down" need different fixes, and an owner cannot
    // tell them apart from an empty dropdown.
    await expect(listModels({ OPENAI_API_KEY: "bad" }, respond({}, 401))).rejects.toThrow(/rejected that key/)
  })

  it("distinguishes nothing configured from nothing offered", async () => {
    await expect(listModels({}, respond({ data: [] }))).rejects.toThrow(ModelListError)
    await expect(listModels({ OPENAI_API_KEY: "sk-x" }, respond({ data: [] }))).resolves.toEqual([])
  })

  it("honours an explicit provider choice over the search order", async () => {
    const f = respond({ data: [{ id: "llama-3.3-70b-versatile" }] })
    await listModels({ OPENAI_API_KEY: "sk-x", GROQ_API_KEY: "gsk", QUIDCHAT_CHAT_PROVIDER: "groq" }, f)
    const [url] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toContain("groq")
  })
})
