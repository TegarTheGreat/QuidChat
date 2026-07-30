import { describe, expect, it } from "vitest"
import { resolveProviders } from "./resolve.js"

describe("default models", () => {
  it("asks each service for a model that service actually has", () => {
    // Every tenant used to be created asking for claude-opus-5 regardless of provider, so Groq,
    // DeepSeek, Together, Fireworks, OpenRouter and every local runner answered unknown_model on
    // the first question a customer asked.
    // One key each, because the search order is the contract: with OpenAI also present it wins
    // chat, and that is deliberate rather than something these assertions should paper over.
    expect(resolveProviders({ GROQ_API_KEY: "k" }).models.chat).toMatch(/llama/)
    expect(resolveProviders({ DEEPSEEK_API_KEY: "k" }).models.chat).toBe("deepseek-chat")
    expect(resolveProviders({ OPENAI_API_KEY: "k" }).models.chat).toMatch(/gpt/)
    expect(resolveProviders({ OLLAMA_BASE_URL: "http://localhost:11434/v1" }).models.chat).toMatch(/llama/)
  })

  it("takes the embedding model from the service doing the embedding", () => {
    // The pairing this resolver exists to produce: chat from Anthropic, embeddings from OpenAI.
    // Reading the embedding default off the CHAT preset would hand Anthropic's name to OpenAI.
    const r = resolveProviders({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" })
    expect(r.chosen).toEqual({ chat: "anthropic", embed: "openai" })
    expect(r.models.chat).toMatch(/claude/)
    expect(r.models.embed).toBe("text-embedding-3-small")
  })

  it("reports no models when nothing usable is configured", () => {
    expect(resolveProviders({}).models).toEqual({ chat: null, embed: null })
  })
})

describe("choosing which service does what", () => {
  it("lets an operator name the chat provider the search order would never pick", () => {
    // Groq has no embeddings endpoint, so using it means also configuring OpenAI — and OpenAI
    // sits ahead of Groq in the search order, so it would win chat too and Groq would never
    // answer anything. This is the combination the order cannot express.
    const withoutPreference = resolveProviders({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o" })
    expect(withoutPreference.chosen).toEqual({ chat: "openai", embed: "openai" })

    const withPreference = resolveProviders({
      GROQ_API_KEY: "g",
      OPENAI_API_KEY: "o",
      QUIDCHAT_CHAT_PROVIDER: "groq",
    })
    expect(withPreference.chosen).toEqual({ chat: "groq", embed: "openai" })
    expect(withPreference.models.chat).toMatch(/llama/)
    expect(withPreference.models.embed).toBe("text-embedding-3-small")
    expect(withPreference.provider).not.toBeNull()
  })

  it("lets an operator name the embedding provider too", () => {
    const r = resolveProviders({
      OPENAI_API_KEY: "o",
      OLLAMA_BASE_URL: "http://localhost:11434/v1",
      QUIDCHAT_EMBED_PROVIDER: "ollama",
    })
    // Embeddings locally, answers from a hosted model: a real deployment shape, and one the
    // search order alone cannot produce.
    expect(r.chosen).toEqual({ chat: "openai", embed: "ollama" })
    expect(r.models.embed).toBe("nomic-embed-text")
  })

  it("ignores a preference that names nothing, rather than refusing to start", () => {
    // A typo in an optional preference should not take an assistant offline. The start-up line
    // reports what was actually picked, which is where someone would notice.
    const typo = resolveProviders({ OPENAI_API_KEY: "o", QUIDCHAT_CHAT_PROVIDER: "opanai" })
    expect(typo.chosen.chat).toBe("openai")
    // Naming a service whose key is absent is the same case.
    const absent = resolveProviders({ OPENAI_API_KEY: "o", QUIDCHAT_CHAT_PROVIDER: "groq" })
    expect(absent.chosen.chat).toBe("openai")
  })
})

describe("the services added from their own documentation", () => {
  it("reaches Gemini through Google's OpenAI-compatible surface", () => {
    // ai.google.dev/gemini-api/docs/openai — same wire format, so no separate adapter.
    const r = resolveProviders({ GEMINI_API_KEY: "k" })
    expect(r.chosen).toEqual({ chat: "gemini", embed: "gemini" })
    expect(r.models).toEqual({ chat: "gemini-3.6-flash", embed: "gemini-embedding-001" })
    expect(r.provider).not.toBeNull()
  })

  it("treats Mistral and xAI as chat-only, so the failure lands at start-up", () => {
    // Neither exposes embeddings on the surface this adapter speaks. Claiming otherwise would
    // move the failure to the first customer question instead of to the operator's terminal.
    for (const env of [{ MISTRAL_API_KEY: "k" }, { XAI_API_KEY: "k" }]) {
      const alone = resolveProviders(env)
      expect(alone.provider, JSON.stringify(env)).toBeNull()
      expect(alone.chosen.embed).toBeNull()
    }

    // Paired with something that embeds, they answer — and the operator says which does what.
    const paired = resolveProviders({
      MISTRAL_API_KEY: "m",
      OPENAI_API_KEY: "o",
      QUIDCHAT_CHAT_PROVIDER: "mistral",
    })
    expect(paired.chosen).toEqual({ chat: "mistral", embed: "openai" })
    expect(paired.models.chat).toBe("mistral-large-latest")
  })

  it("lets every hosted service be pointed somewhere else", () => {
    // A gateway, a proxy, a regional endpoint: each preset takes a base-url override for the
    // same reason OpenAI does, and a deployment that needs one is not exotic.
    const r = resolveProviders({ XAI_API_KEY: "k", XAI_BASE_URL: "https://gateway.internal/v1" })
    expect(r.chosen.chat).toBe("xai")
  })
})
