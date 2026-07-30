import { fetchWithRetry } from "./http.js"
import { ProviderError, type Answer, type Capabilities, type CompleteResult, type Provider, type PromptParts, type ToolCall } from "@quidchat/core"

/** Maps an HTTP status to a failure reason. Not everything is `unavailable`. */
function reasonFromStatus(status: number): "auth" | "unknown_model" | "rate_limit" | "unavailable" {
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "unknown_model"
  if (status === 429) return "rate_limit"
  return "unavailable"
}

/** Strips a trailing slash so `baseUrl` with or without one behaves the same. */
const trimTrailingSlash = (u: string) => u.replace(/\/+$/, "")

/** Builds the messages list in STABLE -> VOLATILE order. LLM caching is
 *  prefix-based, so this order is what determines whether caching works at all.
 *  Reversing this order invalidates the cache on every message, with no error
 *  and no log of any kind. */
function messagesFrom(prompt: PromptParts) {
  return [
    { role: "system", content: prompt.system },
    ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: prompt.currentTurn },
  ]
}

/** Checks the shape of `Answer` before it is trusted. A model can return
 *  well-formed JSON that is still not the shape we asked for. */
export function asAnswer(value: unknown): Answer {
  const o = value as { segments?: unknown }
  if (!Array.isArray(o.segments)) {
    throw new ProviderError("schema", "response has no `segments` array")
  }
  for (const s of o.segments as { kind?: unknown; text?: unknown; citations?: unknown }[]) {
    if (typeof s.text !== "string") {
      throw new ProviderError("schema", "a segment has no `text` of type string")
    }
    if (s.kind !== "general" && s.kind !== "business_claim") {
      throw new ProviderError("schema", `unknown segment kind: ${String(s.kind)}`)
    }
    if (s.kind === "business_claim" && !Array.isArray(s.citations)) {
      throw new ProviderError("schema", "a business_claim segment has no `citations` array")
    }
  }
  return value as Answer
}

/**
 * Adapter for any service that accepts the OpenAI wire format at
 * `POST {baseUrl}/chat/completions`. That covers OpenAI itself, OpenRouter, Groq,
 * Together, DeepSeek, Fireworks, and local runners like Ollama, vLLM, llama.cpp,
 * and LM Studio.
 *
 * `fetchImpl` can be injected so tests never touch the network.
 */
/**
 * Reads the tool calls out of an OpenAI-compatible response.
 *
 * `function.arguments` is a JSON *string* here, not an object — the one difference from
 * Anthropic's shape, and the one that silently yields undefined arguments if the two are treated
 * alike. A call whose arguments will not parse is dropped rather than thrown: the model tried to
 * hand off and garbled it, and answering with the current skill beats failing the question.
 */
function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: ToolCall[] = []
  for (const entry of raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]) {
    const name = entry.function?.name
    if (typeof name !== "string") continue
    let input: Record<string, unknown> = {}
    const args = entry.function?.arguments
    if (typeof args === "string" && args.trim() !== "") {
      let parsed: unknown
      try {
        parsed = JSON.parse(args)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== "object") continue
      input = parsed as Record<string, unknown>
    }
    calls.push({ id: typeof entry.id === "string" ? entry.id : name, name, input })
  }
  return calls
}

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
      // Bounded and retried — see http.ts. Without a timeout a provider that accepts the
      // connection and says nothing holds a customer's question open until the socket dies.
      res = await fetchWithRetry(f, `${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      // Dead network, DNS failure, timeout. Not the model's fault.
      throw new ProviderError("unavailable", `could not reach ${opts.id}`, { cause })
    }
    if (!res.ok) {
      throw new ProviderError(
        reasonFromStatus(res.status),
        `${opts.id} responded ${res.status}`,
        { status: res.status },
      )
    }
    return (await res.json()) as Record<string, unknown>
  }

  return {
    id: opts.id,

    async complete({ model, prompt, tools }): Promise<CompleteResult> {
      const j = await call("/chat/completions", {
        model,
        messages: messagesFrom(prompt),
        response_format: { type: "json_object" },
        // Tools render before the messages, so the list is passed exactly as given — the caller
        // keeps it identical across skills to protect the cached prefix.
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      })
      const choice = (
        j.choices as { message?: { content?: unknown; tool_calls?: unknown } }[] | undefined
      )?.[0]

      // Read tool calls BEFORE the text check. A model that calls a tool returns `content: null`,
      // so checking for text first turns every tool call into a schema error — the handoff would
      // look like a broken provider.
      const toolCalls = parseToolCalls(choice?.message?.tool_calls)
      const usage = (j.usage ?? {}) as Record<string, number | undefined>
      const reportedUsage = {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        // The field that reports cached tokens varies in location across
        // OpenAI-compatible services; `null` means "unknown", not "zero".
        cachedTokens: usage.prompt_cache_hit_tokens ?? null,
      }
      if (toolCalls.length > 0) return { answer: null, toolCalls, usage: reportedUsage }

      const text = choice?.message?.content
      if (typeof text !== "string") {
        throw new ProviderError("schema", "response has no text at choices[0].message.content")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (cause) {
        throw new ProviderError("schema", "the model's response is not valid JSON", { cause })
      }
      return { answer: asAnswer(parsed), toolCalls: [], usage: reportedUsage }
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
        throw new ProviderError("schema", "embeddings response has no `embedding` array")
      }
      return data.embedding as number[]
    },

    async capabilities(): Promise<Capabilities> {
      // Deliberately conservative. A future task will add a capabilities registry;
      // until it exists, numbers that are too optimistic are more dangerous than
      // numbers that are too small — the former causes requests to fail mid-flight.
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
