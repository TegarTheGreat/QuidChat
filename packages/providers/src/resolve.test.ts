import { describe, expect, it } from "vitest"
import { presets } from "./presets.js"
import { resolveProviders } from "./resolve.js"

/** A `fetchImpl` that never actually reaches the network, for injection into
 *  whichever adapter the resolver builds. */
const neverFetch = (() => {
  throw new Error("resolveProviders must not need the network just to resolve")
}) as unknown as typeof fetch

describe("resolveProviders", () => {
  it("returns no provider on an empty environment, and traces every preset as absent", () => {
    const result = resolveProviders({}, neverFetch)
    expect(result.provider).toBeNull()
    expect(result.chosen).toEqual({ chat: null, embed: null })
    expect(result.trace).toHaveLength(presets.length)
    for (const entry of result.trace) {
      expect(entry.present).toBe(false)
    }
  })

  it("picks OpenAI for both chat and embed when only its key is present", () => {
    const result = resolveProviders({ OPENAI_API_KEY: "sk-test" }, neverFetch)
    expect(result.chosen).toEqual({ chat: "openai", embed: "openai" })
    expect(result.provider).not.toBeNull()
    expect(result.provider?.id).toBe("openai")
  })

  it("refuses to return Anthropic alone, since it cannot embed", () => {
    const result = resolveProviders({ ANTHROPIC_API_KEY: "sk-ant-test" }, neverFetch)
    // The most important assertion in this file: handing back a provider that
    // is guaranteed to fail on the first embed call would surface far from its
    // real cause (a missing OpenAI-shaped key).
    expect(result.provider).toBeNull()
    expect(result.chosen.embed).toBeNull()
    // The trace explains why: Anthropic was found, but nothing with an
    // embeddings endpoint was.
    const anthropicEntry = result.trace.find((e) => e.preset === "anthropic")
    expect(anthropicEntry?.present).toBe(true)
    const anyEmbedCapablePresent = presets
      .filter((p) => p.hasEmbeddings)
      .some((p) => result.trace.find((e) => e.preset === p.id)?.present)
    expect(anyEmbedCapablePresent).toBe(false)
  })

  it("composes Anthropic for chat and OpenAI for embed when both keys are present", () => {
    const result = resolveProviders(
      { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test" },
      neverFetch,
    )
    expect(result.chosen).toEqual({ chat: "anthropic", embed: "openai" })
    expect(result.provider).not.toBeNull()
    expect(result.provider?.id).toBe("anthropic+openai")
  })

  it("obeys the documented search order, not the iteration order of the env object", () => {
    // Insertion order here deliberately does NOT match preset search order
    // (OpenAI comes before OpenRouter and Groq in presets.ts, but last in this
    // object) — proving the winner is determined by the fixed preset list, not
    // by object key order.
    const result = resolveProviders(
      { GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o", OPENAI_API_KEY: "x" },
      neverFetch,
    )
    expect(result.chosen).toEqual({ chat: "openai", embed: "openai" })
  })

  it("splits chat and embed across two present presets in search order", () => {
    // Neither Groq nor DeepSeek has embeddings; Together does. Groq precedes
    // Together in the search order, so it wins chat; Together is the first
    // embeddings-capable preset present, so it wins embed.
    const result = resolveProviders(
      { GROQ_API_KEY: "g", TOGETHER_API_KEY: "t" },
      neverFetch,
    )
    expect(result.chosen).toEqual({ chat: "groq", embed: "together" })
    expect(result.provider?.id).toBe("groq+together")
  })

  it("detects a local runner with no key at all, once its base URL is set", async () => {
    const records: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      records.push(String(url))
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const result = resolveProviders({ OLLAMA_BASE_URL: "http://localhost:9999/v1" }, fetchImpl)
    expect(result.chosen).toEqual({ chat: "ollama", embed: "ollama" })
    expect(result.provider?.id).toBe("ollama")

    // The base URL override was actually threaded through, not just detected.
    await result.provider?.embed({ model: "e", text: "hi" })
    expect(records[0]).toBe("http://localhost:9999/v1/embeddings")
  })

  it("lists every preset in the trace, present or not", () => {
    const result = resolveProviders({ OPENAI_API_KEY: "sk-test" }, neverFetch)
    const ids = result.trace.map((e) => e.preset)
    expect(ids).toEqual(presets.map((p) => p.id))
  })
})
