import { ProviderError, type Answer, type Capabilities, type CompleteResult, type Provider, type PromptParts } from "@quidchat/core"

/** Maps an HTTP status code to a failure cause. Not everything is `unavailable`. */
function reasonFromStatus(status: number): "auth" | "unknown_model" | "rate_limit" | "unavailable" {
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "unknown_model"
  if (status === 429) return "rate_limit"
  return "unavailable"
}

/** Strips a trailing slash so `baseUrl` behaves the same with or without one. */
const trimTrailingSlash = (u: string) => u.replace(/\/+$/, "")

/** Builds the message list in STABLE -> VOLATILE order. LLM caching is prefix-based,
 *  so this ordering is what determines whether caching works at all. */
function messagesFrom(prompt: PromptParts) {
  return [
    { role: "system", content: prompt.system },
    ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: prompt.currentTurn },
  ]
}

/** Validates the shape of an `Answer` before trusting it. A model can return
 *  well-formed JSON that is still not the shape we asked for. */
export function asAnswer(value: unknown): Answer {
  const o = value as { segments?: unknown }
  if (!Array.isArray(o.segments)) {
    throw new ProviderError("schema", "response is missing a `segments` array")
  }
  for (const s of o.segments as { kind?: unknown; text?: unknown; citations?: unknown }[]) {
    if (typeof s.text !== "string") {
      throw new ProviderError("schema", "a segment is missing a string `text` field")
    }
    if (s.kind !== "general" && s.kind !== "business_claim") {
      throw new ProviderError("schema", `unrecognized segment kind: ${String(s.kind)}`)
    }
    if (s.kind === "business_claim" && !Array.isArray(s.citations)) {
      throw new ProviderError("schema", "business_claim segment is missing a `citations` array")
    }
  }
  return value as Answer
}

/**
 * Adapter for any service that speaks the OpenAI wire format at
 * `POST {baseUrl}/chat/completions`. That covers OpenAI itself, OpenRouter, Groq,
 * Together, DeepSeek, Fireworks, and local runners such as Ollama, vLLM, llama.cpp,
 * and LM Studio.
 *
 * `fetchImpl` can be injected so tests never touch the network.
 */
export function openAiCompatible(opts: {
  id: string
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}): Provider {
  const base = trimTrailingSlash(opts.baseUrl)
  const f = opts.fetchImpl ?? fetch

  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await f(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      // Network down, DNS failure, timeout. Not the model's fault.
      throw new ProviderError("unavailable", `could not reach ${opts.id}`, { cause })
    }
    if (!res.ok) {
      throw new ProviderError(
        reasonFromStatus(res.status),
        `${opts.id} responded with ${res.status}`,
        { status: res.status },
      )
    }
    return (await res.json()) as Record<string, unknown>
  }

  return {
    id: opts.id,

    async complete({ model, prompt }): Promise<CompleteResult> {
      const j = await call("/chat/completions", {
        model,
        messages: messagesFrom(prompt),
        response_format: { type: "json_object" },
      })
      const choice = (j.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
      const text = choice?.message?.content
      if (typeof text !== "string") {
        throw new ProviderError("schema", "response has no text at choices[0].message.content")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (cause) {
        throw new ProviderError("schema", "model response is not valid JSON", { cause })
      }
      const usage = (j.usage ?? {}) as Record<string, number | undefined>
      return {
        answer: asAnswer(parsed),
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          // The field that reports cached tokens differs across OpenAI-compatible
          // services; `null` means "unknown", not "zero".
          cachedTokens: usage.prompt_cache_hit_tokens ?? null,
        },
      }
    },

    async generateText({ model, system, user }): Promise<string> {
      const j = await call("/chat/completions", {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      })
      const choice = (j.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
      const text = choice?.message?.content
      if (typeof text !== "string") {
        throw new ProviderError("schema", "response has no text")
      }
      return text
    },

    async embed({ model, text }): Promise<number[]> {
      const j = await call("/embeddings", { model, input: text })
      const data = (j.data as { embedding?: unknown }[] | undefined)?.[0]
      if (!Array.isArray(data?.embedding)) {
        throw new ProviderError("schema", "embeddings response is missing an `embedding` array")
      }
      return data.embedding as number[]
    },

    async capabilities(): Promise<Capabilities> {
      // Deliberately conservative. A later task adds a capability registry; until
      // then, an overly optimistic number is more dangerous than an overly small
      // one — the former causes requests to be rejected mid-flight.
      return {
        contextWindow: 128_000,
        maxOutput: 4_096,
        tools: false,
        vision: false,
        thinking: false,
        promptCaching: false,
      }
    },
  }
}
