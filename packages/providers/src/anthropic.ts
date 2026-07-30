import { ProviderError, type Capabilities, type CompleteResult, type Provider, type PromptParts } from "@quidchat/core"
import { asAnswer } from "./openai-compatible.js"

/** Maps an HTTP status to a failure reason. Same mapping as the OpenAI-compatible
 *  adapter — escalation reasons are a business signal, not an implementation detail. */
function reasonFromStatus(status: number): "auth" | "unknown_model" | "rate_limit" | "unavailable" {
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "unknown_model"
  if (status === 429) return "rate_limit"
  return "unavailable"
}

/** Strips a trailing slash so `baseUrl` with or without one behaves the same. */
const trimTrailingSlash = (u: string) => u.replace(/\/+$/, "")

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
const ANTHROPIC_VERSION = "2023-06-01"

/** Builds the `messages` array in STABLE -> VOLATILE order: history, then the
 *  current turn. `system` is deliberately NOT in here — on Anthropic's wire format
 *  it is a top-level field, not a `role: "system"` message. */
function messagesFrom(prompt: PromptParts) {
  return [
    ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: prompt.currentTurn },
  ]
}

/**
 * Native Anthropic adapter for `POST {baseUrl}/messages`.
 *
 * Kept separate from the OpenAI-compatible adapter for two reasons that make
 * Anthropic unmappable onto that shape: `system` is a top-level field, not a
 * message with `role: "system"`; and prompt caching uses `cache_control` on a
 * content block rather than an implicit provider-side cache. The cache breakpoint
 * sits on the last block of `system` precisely because `PromptParts` is ordered
 * stable -> volatile (system, then history, then the current turn) — if that
 * breakpoint is ever lost there is no error and no log, only the bill.
 *
 * `fetchImpl` can be injected so tests never touch the network.
 */
export function anthropic(opts: {
  id?: string
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): Provider {
  const id = opts.id ?? "anthropic"
  const base = trimTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL)
  const f = opts.fetchImpl ?? fetch

  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await f(`${base}${path}`, {
        method: "POST",
        headers: {
          // NOT `Authorization: Bearer` — that's the OpenAI-compatible shape, and
          // copying it here is the obvious mistake this adapter exists to avoid.
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      // Dead network, DNS failure, timeout. Not the model's fault.
      throw new ProviderError("unavailable", `could not reach ${id}`, { cause })
    }
    if (!res.ok) {
      throw new ProviderError(
        reasonFromStatus(res.status),
        `${id} membalas ${res.status}`,
        { status: res.status },
      )
    }
    return (await res.json()) as Record<string, unknown>
  }

  return {
    id,

    async complete({ model, prompt }): Promise<CompleteResult> {
      const j = await call("/messages", {
        model,
        max_tokens: 4096,
        // `system` as an ARRAY of blocks, with `cache_control` on the last one.
        // This is the cache breakpoint — prompt caching is prefix-based, and
        // `PromptParts` is already ordered stable -> volatile precisely so this
        // breakpoint can sit here.
        system: [
          { type: "text", text: prompt.system, cache_control: { type: "ephemeral" } },
        ],
        messages: messagesFrom(prompt),
      })
      const content = j.content as { type?: string; text?: unknown }[] | undefined
      const text = content?.[0]?.text
      if (typeof text !== "string") {
        throw new ProviderError("schema", "response has no text at content[0].text")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (cause) {
        throw new ProviderError("schema", "the model's response is not valid JSON", { cause })
      }
      const usage = (j.usage ?? {}) as Record<string, number | undefined>
      return {
        answer: asAnswer(parsed),
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cachedTokens: usage.cache_read_input_tokens ?? null,
        },
      }
    },

    async generateText({ model, system, user }): Promise<string> {
      const j = await call("/messages", {
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: user }],
      })
      const content = j.content as { type?: string; text?: unknown }[] | undefined
      const text = content?.[0]?.text
      if (typeof text !== "string") {
        throw new ProviderError("schema", "response has no text at content[0].text")
      }
      return text
    },

    async embed(): Promise<number[]> {
      // Anthropic has no embeddings endpoint. Name the fix, not just the failure:
      // pair this provider with another one's embeddings via composite().
      throw new ProviderError(
        "unknown_model",
        "Anthropic has no embeddings endpoint; pair it with another provider's embeddings using composite()",
      )
    },

    async capabilities(): Promise<Capabilities> {
      return {
        contextWindow: 200_000,
        maxOutput: 4_096,
        tools: false,
        vision: false,
        thinking: false,
        // Unlike the OpenAI-compatible adapter, this one genuinely supports
        // prompt caching — see the cache breakpoint built in `complete()` above.
        promptCaching: { minPrefixTokens: 1024, maxBreakpoints: 4 },
      }
    },
  }
}
