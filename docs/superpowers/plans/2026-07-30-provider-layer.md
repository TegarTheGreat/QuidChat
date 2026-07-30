# Provider Layer Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Historical record.** This plan describes work that is complete. The code has moved on since
> it was written — most visibly, the codebase was translated to English after these tasks landed,
> so the Indonesian strings in the code samples below are what was built at the time, not what is
> in the repository now. Read it for the reasoning behind a decision; read the code for what the
> code does.


**Goal:** One `@quidchat/providers` package that covers every LLM provider and router with a setup that's as close to zero-configuration as possible, plus closes two debts recorded in spec §11.5.

**Architecture:** `packages/core` stays a pure library — no network, no `process.env`. A new `packages/providers` package is allowed both. One OpenAI-compatible adapter covers the majority of services because almost every router speaks that wire format; Anthropic gets a native adapter because its prompt caching is different and the project's whole cost story depends on it.

**Tech Stack:** Node 22's built-in `fetch` — no SDK, no new runtime dependency.

## Why this plan exists

Three things, two of them already recorded as debt:

1. **Provider failures are mislabeled.** Every `complete()` that throws is recorded as `schema_invalid`. So 429s, 503s, and timeouts land in the `escalations` table as schema violations — contaminating the one signal a business owner uses to decide what content needs writing. An owner who sees "model didn't comply with the schema" will rewrite a knowledge base that was never the problem.
2. **The repair round still can't rewrite the query.** Spec §4 step 6 asks for it, `TenantConfig.rewriteModel` already exists and is **completely unused**, because `Provider` has no plain-text completion method.
3. **Not a single adapter exists yet.** The pipeline works against a fake `Provider`. Without a real adapter, the product can't answer anyone yet.

## Global Constraints

- Node `>=22.22.3`. TypeScript strict; `exactOptionalPropertyTypes: true`.
- ESM only; TypeScript source imports use the `.js` extension.
- **`packages/core` stays free of runtime dependencies, `process.env`, and network access.** The `providers` package holds both.
- **No new runtime dependency anywhere in the repo.** `fetch` already exists in Node 22.
- **Tests must not touch the network.** Every adapter is tested with a stubbed `fetch`.
- Every `execute()` goes through `rowsOf()` (where it touches `packages/db`).
- **Code comments and commit messages are in ENGLISH.** Identifiers too.
  The ONLY thing that stays Indonesian is product copy: system prompts, refusal
  text, `high_risk_topics`, and fixture data — that's content read by Indonesian
  business customers, not code.
  Production code in `packages/core` and `packages/db` already follows this: `rowsOf`,
  `createStore`, `getTenantConfig`, `withTenant`, `applyMigrations`. Code snippets
  in this plan used to use Indonesian identifiers — that was a mistake and has been
  corrected. If a snippet and the rule conflict, **the rule wins**.
- Commits carry no attribution trailer of any kind. `git add` with explicit paths, **never** `git add -A`.
- `pnpm build` is part of verification on every task.
- Any fix that claims to pin down a property **must** be proven by breaking the code and watching the relevant test fail. Three rounds of hardening found 14 defects this way, and zero any other way.

## Design decisions, and why

**One OpenAI-compatible adapter covers most of it.** OpenRouter, Groq, Together, DeepSeek, Fireworks, Ollama, vLLM, llama.cpp, and LM Studio all accept `POST /chat/completions` in the same shape. So "cover everything" doesn't mean writing twenty adapters — it means one adapter plus a preset table of base URLs and environment variable names.

**Anthropic gets a native adapter.** Its message shape is different (`system` is separate from `messages`), and its prompt caching uses `cache_control` on a content block. Forcing it into the OpenAI-compatible adapter would kill caching — and required test #3 exists specifically to guard that caching.

**Chat and embeddings may come from DIFFERENT providers.** Anthropic has no embeddings endpoint. `TenantConfig` already separates `chatModel` and `embeddingModel`, so this layer provides `composite()`, which routes `complete` to one adapter and `embed` to another. Anthropic chat plus OpenAI embeddings is the most likely real-world setup, and without this it's impossible.

**"Magic" setup = detection from the environment.** A deterministic search order over already-known variable names, and an explicit report of what was detected. Not magic that hides decisions — magic that removes a step, then tells you what it chose.

---

### Task 1: Typed error, `generateText`, and correct mapping in the pipeline

**Files:**
- Modify: `packages/core/src/provider.ts`
- Create: `packages/core/src/provider-error.ts`
- Modify: `packages/core/src/pipeline.ts`
- Modify: `packages/core/src/testing/fakes.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/pipeline.test.ts`

**Interfaces:**
- Produces: `ProviderError` (class), `ProviderErrorKind`, `Provider.generateText`

- [ ] **Step 1: Create `packages/core/src/provider-error.ts`**

```ts
/**
 * The reason a provider failed, split out because the CONSEQUENCE differs.
 *
 * This isn't taxonomy for its own sake. The `EscalationReason` recorded to the
 * `escalations` table is a business signal: the business owner reads it to decide what
 * content needs writing. If 429s and 503s get recorded as `schema_invalid`, they'll
 * rewrite a knowledge base that was never the problem.
 */
export type ProviderErrorKind =
  /** The model replied with something that can't be mapped to `Answer`. This is the
   *  ONLY one that deserves to become `schema_invalid`. */
  | "schema"
  /** 429, or quota exhausted. The service is alive, we're the ones being throttled. */
  | "rate_limit"
  /** 5xx, network down, timeout. The service itself has a problem. */
  | "unavailable"
  /** 401/403, wrong key or no access to that model. Misconfiguration. */
  | "auth"
  /** The requested model isn't recognized by this provider. Misconfiguration. */
  | "unknown_model"

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { status?: number; cause?: unknown } = {},
  ) {
    super(message)
    this.name = "ProviderError"
    if (options.cause !== undefined) this.cause = options.cause
  }

  /** True if retrying the same request makes sense. */
  get isRetryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable"
  }
}
```

- [ ] **Step 2: Add `generateText` to `Provider`**

In `packages/core/src/provider.ts`:

```ts
export interface Provider {
  readonly id: string
  /** Produces a structured answer. Throws `ProviderError` — see `ProviderErrorKind`. */
  complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult>
  /**
   * Plain-text completion, no schema. Used for internal work whose output isn't a
   * customer-facing answer — rewriting the query on the repair round, for example.
   * Deliberately does NOT return an `Answer`: the output is never shown to a visitor,
   * so it doesn't need to, and must not, pass through the grounding validator.
   */
  generateText(args: { model: string; system: string; user: string }): Promise<string>
  embed(args: { model: string; text: string }): Promise<number[]>
  capabilities(model: string): Promise<Capabilities>
}
```

- [ ] **Step 3: Map `ProviderError` to `EscalationReason` in the pipeline**

In `packages/core/src/pipeline.ts`, add a helper and use it in both `catch` blocks:

```ts
/**
 * Translates a provider failure into an escalation reason. Not `schema_invalid` for
 * everything — see `ProviderErrorKind` for why the distinction matters. An error that
 * is NOT a `ProviderError` is treated as unavailable, not as a schema violation: we
 * don't know the cause, and accusing the model is worse than admitting we don't know.
 */
function escalationReasonFor(e: unknown): EscalationReason {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case "schema":
        return "schema_invalid"
      case "rate_limit":
      case "unavailable":
      case "auth":
      case "unknown_model":
        return "provider_unavailable"
    }
  }
  return "provider_unavailable"
}
```

then:

```ts
  try {
    embedding = await provider.embed({ model: config.embeddingModel, text: question })
  } catch (e) {
    return refuse(escalationReasonFor(e))
  }
```

and inside the loop:

```ts
    try {
      result = await provider.complete({ model: config.chatModel, prompt })
    } catch (e) {
      return refuse(escalationReasonFor(e))
    }
```

- [ ] **Step 4: Update `FakeProvider` and export from index**

`FakeProvider` gets a `generateText` that records its calls:

```ts
  textCalls: { system: string; user: string }[] = []
  /** Reply returned by `generateText`, settable by tests. */
  textReply = "rewritten question"

  async generateText(args: { model: string; system: string; user: string }): Promise<string> {
    this.textCalls.push({ system: args.system, user: args.user })
    return this.textReply
  }
```

Add `export * from "./provider-error.js"` to `packages/core/src/index.ts`.

- [ ] **Step 5: Test that the mapping is correct**

In `packages/core/src/pipeline.test.ts`, replace the existing `schema_invalid` test with one table-driven test:

```ts
  it("maps every provider failure cause to the correct escalation reason", async () => {
    // The old test only proved that a throwing provider produced `schema_invalid`.
    // That was exactly the defect: 429s and 503s got recorded the same way, and a
    // business owner reading "model didn't comply with the schema" would rewrite a
    // knowledge base that wasn't the problem.
    const cases: [ProviderErrorKind | "not-a-ProviderError", EscalationReason][] = [
      ["schema", "schema_invalid"],
      ["rate_limit", "provider_unavailable"],
      ["unavailable", "provider_unavailable"],
      ["auth", "provider_unavailable"],
      ["unknown_model", "provider_unavailable"],
      ["not-a-ProviderError", "provider_unavailable"],
    ]

    for (const [cause, expected] of cases) {
      const store = new MemoryStore([candidate])
      const provider: Provider = {
        id: "broken",
        complete: async () => {
          throw cause === "not-a-ProviderError"
            ? new Error("something we don't recognize")
            : new ProviderError(cause, `failed: ${cause}`)
        },
        generateText: async () => "",
        embed: async () => Array.from({ length: 1536 }, () => 0),
        capabilities: async () => ({
          contextWindow: 1, maxOutput: 1, tools: false, vision: false,
          thinking: false, promptCaching: false as const,
        }),
      }
      const res = await answer({ store, provider, ...ctx })
      expect(res.kind).toBe("refused")
      if (res.kind === "refused") expect(res.reason).toBe(expected)
    }
  })
```

- [ ] **Step 6: Verify**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then prove the new test can fail: change `escalationReasonFor` to always return `"schema_invalid"` and confirm the test **fails** on the `rate_limit` case. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): give provider failures a cause so escalations stay meaningful"
```

---

### Task 2: OpenAI-compatible adapter

**Files:**
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`
- Create: `packages/providers/src/index.ts`
- Create: `packages/providers/src/openai-compatible.ts`
- Create: `packages/providers/src/openai-compatible.test.ts`

**Interfaces:**
- Produces: `openAiCompatible(opts: { id: string; baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): Provider`

This one adapter covers OpenAI, OpenRouter, Groq, Together, DeepSeek, Fireworks, Ollama, vLLM, llama.cpp, and LM Studio, because all of them accept `POST {baseUrl}/chat/completions` in the same shape.

- [ ] **Step 1: Scaffold the package**

`packages/providers/package.json` — declares only what this task creates:

```json
{
  "name": "@quidchat/providers",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.22.3" },
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsdown src/index.ts --dts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@quidchat/core": "workspace:*" }
}
```

`packages/providers/tsconfig.json` copies the shape used by `packages/db`.

- [ ] **Step 2: Write the test first, with a stubbed `fetch`**

Create `packages/providers/src/openai-compatible.test.ts`. `fakeFetch` records requests and returns a prepared reply, so the test never touches the network:

```ts
import { ProviderError } from "@quidchat/core"
import { describe, expect, it } from "vitest"
import { openAiCompatible } from "./openai-compatible.js"

type Recorded = { url: string; body: Record<string, unknown>; headers: Record<string, string> }

function fakeFetch(reply: { status?: number; json?: unknown; body?: string }) {
  const recorded: Recorded[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    recorded.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const status = reply.status ?? 200
    const text = reply.body ?? JSON.stringify(reply.json ?? {})
    return new Response(text, { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { impl, recorded }
}

const prompt = {
  system: "you are an assistant",
  history: [{ role: "user" as const, content: "hi" }],
  currentTurn: "<context>[k1] content</context>\nCustomer question: warranty?",
}

const validAnswer = {
  choices: [{
    message: {
      content: JSON.stringify({
        segments: [{ text: "12-month warranty.", kind: "business_claim", citations: ["k1"] }],
      }),
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
}

describe("openAiCompatible", () => {
  it("sends system, history, and the current turn in that order", async () => {
    const { impl, recorded } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })

    expect(recorded[0]!.url).toBe("https://example.id/v1/chat/completions")
    const messages = recorded[0]!.body.messages as { role: string; content: string }[]
    // The order is NOT taste: LLM caching is prefix-based, so the stable part must
    // come first and the volatile part last. Flipping this invalidates the cache on
    // every single message with no error at all — exactly the regression required
    // test #3 in packages/core guards against.
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"])
    expect(messages[0]!.content).toBe("you are an assistant")
    expect(messages[1]!.content).toBe("hi")
    expect(messages[2]!.content).toContain("Customer question: warranty?")
  })

  it("parses the structured answer and reports token usage", async () => {
    const { impl } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "k", fetchImpl: impl })
    const result = await p.complete({ model: "m", prompt })
    expect(result.answer.segments).toHaveLength(1)
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
  })

  it("carries the key in the Authorization header", async () => {
    const { impl, recorded } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "secret", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(recorded[0]!.headers.Authorization).toBe("Bearer secret")
  })

  it("maps HTTP status to the correct ProviderError cause", async () => {
    const cases: [number, string][] = [
      [401, "auth"], [403, "auth"], [404, "unknown_model"],
      [429, "rate_limit"], [500, "unavailable"], [503, "unavailable"],
    ]
    for (const [status, cause] of cases) {
      const { impl } = fakeFetch({ status, json: { error: { message: "x" } } })
      const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "k", fetchImpl: impl })
      await expect(p.complete({ model: "m", prompt })).rejects.toThrow(ProviderError)
      await p.complete({ model: "m", prompt }).catch((e: unknown) => {
        expect((e as ProviderError).kind).toBe(cause)
      })
    }
  })

  it("a non-JSON reply becomes cause `schema`, not `unavailable`", async () => {
    // The distinction matters: `schema` records `schema_invalid` in escalations and
    // that IS the correct signal that the model failed to comply with the format.
    // `unavailable` records something else.
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "sorry, not JSON" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("rejects JSON that isn't shaped like an Answer", async () => {
    const { impl } = fakeFetch({
      json: { choices: [{ message: { content: JSON.stringify({ not: "segments" }) } }] },
    })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("embed returns a vector from the embeddings endpoint", async () => {
    const { impl, recorded } = fakeFetch({ json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "k", fetchImpl: impl })
    const v = await p.embed({ model: "e", text: "hi" })
    expect(v).toEqual([0.1, 0.2, 0.3])
    expect(recorded[0]!.url).toBe("https://example.id/v1/embeddings")
  })

  it("generateText returns text as-is, without parsing JSON", async () => {
    const { impl } = fakeFetch({ json: { choices: [{ message: { content: "how many months warranty" } }] } })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1", apiKey: "k", fetchImpl: impl })
    const t = await p.generateText({ model: "m", system: "rewrite", user: "warranty?" })
    expect(t).toBe("how many months warranty")
  })

  it("a baseUrl with a trailing slash doesn't produce a doubled URL", async () => {
    const { impl, recorded } = fakeFetch({ json: validAnswer })
    const p = openAiCompatible({ id: "test", baseUrl: "https://example.id/v1/", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(recorded[0]!.url).toBe("https://example.id/v1/chat/completions")
  })
})
```

- [ ] **Step 3: Run the test to make sure it fails**

Run: `pnpm vitest run packages/providers/src/openai-compatible.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 4: Implement**

Create `packages/providers/src/openai-compatible.ts`. Points that must not change: the `system → history → currentTurn` order, and the status-to-cause mapping.

```ts
import { ProviderError, type Answer, type Capabilities, type CompleteResult, type Provider, type PromptParts } from "@quidchat/core"

/** Maps an HTTP status to a failure cause. Not everything is `unavailable`. */
function reasonFromStatus(status: number): "auth" | "unknown_model" | "rate_limit" | "unavailable" {
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "unknown_model"
  if (status === 429) return "rate_limit"
  return "unavailable"
}

/** Strips a trailing slash so `baseUrl` with or without one is the same. */
const trimTrailingSlash = (u: string) => u.replace(/\/+$/, "")

/** Checks the shape of `Answer` before trusting it. The model can reply with valid
 *  JSON that isn't the shape we asked for. */
export function asAnswer(value: unknown): Answer {
  const o = value as { segments?: unknown }
  if (!Array.isArray(o.segments)) {
    throw new ProviderError("schema", "reply has no `segments` array")
  }
  for (const s of o.segments as { kind?: unknown; text?: unknown; citations?: unknown }[]) {
    if (typeof s.text !== "string") {
      throw new ProviderError("schema", "a segment has no string `text`")
    }
    if (s.kind !== "general" && s.kind !== "business_claim") {
      throw new ProviderError("schema", `unrecognized segment kind: ${String(s.kind)}`)
    }
    if (s.kind === "business_claim" && !Array.isArray(s.citations)) {
      throw new ProviderError("schema", "business_claim without a `citations` array")
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
        `${opts.id} replied ${res.status}`,
        { status: res.status },
      )
    }
    return (await res.json()) as Record<string, unknown>
  }

  /** Builds messages in STABLE -> VOLATILE order. LLM caching is prefix-based, so
   *  this order is what determines whether caching works at all. */
  function messagesFrom(prompt: PromptParts) {
    return [
      { role: "system", content: prompt.system },
      ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: prompt.currentTurn },
    ]
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
        throw new ProviderError("schema", "reply has no text at choices[0].message.content")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (cause) {
        throw new ProviderError("schema", "model reply is not valid JSON", { cause })
      }
      const usage = (j.usage ?? {}) as Record<string, number | undefined>
      return {
        answer: asAnswer(parsed),
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          // The OpenAI format reports cache tokens in a different place per service;
          // `null` means "unknown", not "zero".
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
        throw new ProviderError("schema", "reply has no text")
      }
      return text
    },

    async embed({ model, text }): Promise<number[]> {
      const j = await call("/embeddings", { model, input: text })
      const data = (j.data as { embedding?: unknown }[] | undefined)?.[0]
      if (!Array.isArray(data?.embedding)) {
        throw new ProviderError("schema", "embeddings reply has no `embedding` array")
      }
      return data.embedding as number[]
    },

    async capabilities(): Promise<Capabilities> {
      // Deliberately conservative. The next task adds a capabilities registry;
      // until it exists, numbers that are too optimistic are more dangerous than
      // numbers that are too small — the former causes requests to be rejected
      // partway through.
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
```

And `packages/providers/src/index.ts`:

```ts
export * from "./openai-compatible.js"
```

- [ ] **Step 5: Verify**

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then prove the message-order test can fail: swap the order of `history` and `currentTurn` in `messagesFrom`, confirm the first test **fails**, restore. Report it.

And confirm there are **no** real network calls: `grep -rn "fetch(" packages/providers/src/*.test.ts` must return zero hits besides the stub itself.

- [ ] **Step 6: Commit**

```bash
git add packages/providers pnpm-lock.yaml
git commit -m "feat(providers): add one adapter for every OpenAI-compatible service"
```

---

### Task 3: Anthropic adapter with prompt caching

**Files:**
- Create: `packages/providers/src/anthropic.ts`
- Create: `packages/providers/src/anthropic.test.ts`
- Modify: `packages/providers/src/index.ts`

Anthropic gets its own adapter because of two things that can't be mapped to the OpenAI shape: `system` is separate from `messages`, and prompt caching uses `cache_control` on a content block. The project's entire cost story depends on that caching.

- [ ] **Step 1: Test first**

Create `packages/providers/src/anthropic.test.ts` with the same shape of `fakeFetch`. What must be tested:

- The URL is `{baseUrl}/messages`, and the headers use `x-api-key` plus `anthropic-version`, **not** `Authorization: Bearer`.
- `system` is sent as an array of blocks with `cache_control: { type: "ephemeral" }` on the last block — this is the cache point, and without this test caching can vanish with no symptom besides the bill.
- `messages` contains history then `currentTurn`, and does **not** contain `system`.
- `usage.cache_read_input_tokens` maps to `usage.cachedTokens`.
- HTTP status maps to the same causes as the OpenAI-compatible adapter.
- `embed` throws `ProviderError` with cause `unknown_model` and a message that says Anthropic has no embeddings endpoint and suggests `composite()`. This isn't a failure that needs hiding — it must point people to the fix.

- [ ] **Step 2: Implement**

Request shape:

```ts
      const j = await call("/messages", {
        model,
        max_tokens: 4096,
        // `system` as an ARRAY of blocks, with cache_control on the last block. This is
        // the cache point. Prompt caching is prefix-based, and `PromptParts` is already
        // built stable -> volatile precisely so this point can be placed here.
        system: [
          { type: "text", text: prompt.system, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: prompt.currentTurn },
        ],
      })
```

Headers:

```ts
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
```

The reply comes from `content[0].text`, then gets parsed and validated with the same `asAnswer` — **export that helper from `openai-compatible.ts`** instead of copying it, so validation of the `Answer` shape has only one definition.

`usage` is mapped from `input_tokens`, `output_tokens`, and `cache_read_input_tokens`.

`capabilities` returns `promptCaching: { minPrefixTokens: 1024, maxBreakpoints: 4 }` — this is the adapter that genuinely supports it.

- [ ] **Step 3: Verify, then prove the cache test can fail**

Remove `cache_control` from the system block, confirm the relevant test **fails**, restore. That's the only way to be sure caching is actually wired up: if it disappears, there's no error and no log — only the bill.

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/providers/src
git commit -m "feat(providers): add the Anthropic adapter with its cache breakpoint"
```

---

### Task 4: Zero-configuration setup — presets, environment detection, and composite

**Files:**
- Create: `packages/providers/src/presets.ts`
- Create: `packages/providers/src/resolve.ts`
- Create: `packages/providers/src/composite.ts`
- Create: `packages/providers/src/resolve.test.ts`
- Create: `packages/providers/src/composite.test.ts`
- Modify: `packages/providers/src/index.ts`

This is the "magic" part you asked for. Its shape isn't magic that hides decisions, but magic that **removes a step and then tells you what it chose**.

- [ ] **Step 1: Preset table**

`packages/providers/src/presets.ts` maps service names to base URLs and environment variable names. At minimum: `openai`, `anthropic`, `openrouter`, `groq`, `together`, `deepseek`, `fireworks`, `ollama`, `vllm`, `lmstudio`, `llamacpp`.

Local presets (`ollama`, `vllm`, `lmstudio`, `llamacpp`) need no key — set `apiKeyOptional: true` and use an empty string when the variable is absent. Their default base URLs are `http://localhost:11434/v1`, `http://localhost:8000/v1`, `http://localhost:1234/v1`, `http://localhost:8080/v1`.

Every preset also states `kind: "openai-compatible" | "anthropic"` so the resolver knows which adapter to use.

- [ ] **Step 2: Resolver with a report**

`resolveProviders(env: Record<string, string | undefined>): ResolveResult` returns:

```ts
export type ResolveResult = {
  /** Ready-to-use provider, or null if not a single one could be formed. */
  provider: Provider | null
  /** What was chosen for chat and for embedding, so it can be displayed. */
  chosen: { chat: string | null; embed: string | null }
  /** Every preset that was checked and its outcome. This is what makes the "magic"
   *  accountable: the user can see WHY something got chosen. */
  trace: { preset: string; variable: string; present: boolean }[]
}
```

The rules are deterministic and **must be tested**: the search order is fixed, and the first preset whose variable is present wins for chat. For embedding, the first preset that **has an embeddings endpoint** wins — so if only Anthropic is available, `chosen.embed` is `null` and `provider` is `null`, with a trace that explains why. Handing back a provider that can't embed would fail on the first request, far from the cause.

The resolver **doesn't** read `process.env` itself — it receives `env` as an argument. That's what makes it testable without touching the real environment, and what preserves the boundary that only the outermost layer touches the process.

- [ ] **Step 3: Composite**

`composite({ chat, embed }: { chat: Provider; embed: Provider }): Provider` routes `complete` and `generateText` to `chat`, `embed` to `embed`, and `capabilities` to `chat`. Its `id` combines both, e.g. `"anthropic+openai"`, so logs and error messages name both.

This is what makes the most likely real-world combination possible: chat from Anthropic, embeddings from OpenAI.

- [ ] **Step 4: Test**

Required:
- Empty env → `provider` null, `trace` lists every preset with `present: false`.
- Only `OPENAI_API_KEY` → both chat and embed are `openai`, a single provider.
- Only `ANTHROPIC_API_KEY` → `provider` **null**, `chosen.embed` null, and the trace explains why. This is the most important test in this task — it stops this layer from handing back a provider that's guaranteed to fail later.
- Both `ANTHROPIC_API_KEY` **and** `OPENAI_API_KEY` → composite, `id` names both, chat goes to Anthropic.
- Preset order is respected when multiple keys are present at once.
- A local preset is detected with no key at all when its base URL is set via a variable.
- `composite` routes correctly: `complete` only touches the chat adapter, `embed` only touches the embed adapter — proven with two fake providers that record their calls.

- [ ] **Step 5: Verify**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then prove the Anthropic-alone test can fail: make the resolver return the Anthropic adapter as the sole provider, confirm the test **fails**, restore.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src
git commit -m "feat(providers): resolve a provider from the environment, and say what it chose"
```

---

### Task 5: Provider contract test, and the repair round that rewrites the query

**Files:**
- Create: `packages/providers/src/contract.test.ts`
- Modify: `packages/core/src/pipeline.ts`
- Modify: `packages/core/src/pipeline.test.ts`

- [ ] **Step 1: Contract test that applies to EVERY adapter**

Spec §11 asks for this: *"Provider contract — every adapter satisfies the same interface."* One test file that runs the same table of cases against every adapter, so the next adapter can't land with divergent behavior.

Checked for every adapter, with `fetch` stubbed:

- `id` isn't empty.
- `complete` returns a valid `Answer` on a correct reply.
- `complete` throws `ProviderError` with cause `schema` on a non-JSON reply.
- Status 429 → `rate_limit`; 401 → `auth`; 500 → `unavailable`; 404 → `unknown_model`.
- `generateText` returns a string without parsing JSON.
- `capabilities` returns positive `contextWindow` and `maxOutput` numbers.
- Network failure (a throwing fetch) → `unavailable`, **not** `schema`.

Write it as `describe.each` over the list of adapters, so adding an adapter means adding one row.

- [ ] **Step 2: Repair round rewrites the query**

This closes the second debt from §11.5. Right now the second round only carries forward verdict feedback. Spec §4 step 6 asks for the query to be rewritten and retrieval repeated, and `TenantConfig.rewriteModel` exists for exactly this.

In `packages/core/src/pipeline.ts`, inside the loop, after a failed verdict and **only if there's a next round**:

```ts
    // Repair round: rewrite the question and re-retrieve, rather than just sending the
    // same prompt with a note attached. Spec §4 step 6 asks for this, and `rewriteModel`
    // exists precisely for it.
    //
    // If the rewrite fails, that's NOT a reason to refuse: we still have the candidates
    // from the first round and the verdict feedback. So the failure is swallowed and the
    // next round runs with what it already has.
    if (round < MAX_ROUNDS) {
      feedback = `${verdict.violation} — ${verdict.detail}`
      try {
        const rewritten = await provider.generateText({
          model: config.rewriteModel,
          system:
            "Rewrite the customer's question into a single, more specific search " +
            "query. Answer ONLY with the query, no explanation.",
          user: question,
        })
        const cleaned = rewritten.trim()
        if (cleaned.length > 0) {
          const newEmbedding = await provider.embed({
            model: config.embeddingModel,
            text: cleaned,
          })
          const newCandidates = await store.searchChunks({
            tenantId, query: cleaned, embedding: newEmbedding,
            embeddingModel: config.embeddingModel, limit: CANDIDATE_LIMIT,
          })
          // Only used if it produced something. Empty retrieval is worse than the
          // imperfect candidates from the first round.
          if (newCandidates.length > 0) candidates = newCandidates
        }
      } catch {
        // Deliberately swallowed — see comment above.
      }
    }
```

`candidates` needs to become `let`, and `feedback` is still carried forward as before.

- [ ] **Step 3: Test that the rewrite genuinely happens and is genuinely used**

Required:
- The second round uses `rewriteModel` for `generateText`, not `chatModel` — proven from `provider.textCalls` and the model recorded.
- When the rewrite produces new candidates, the second-round prompt contains them.
- When `generateText` throws, the pipeline **still** attempts the second round and does not refuse because of it.
- When re-retrieval is empty, the first round's candidates are still used.
- `prefixOf` for the first and second round stays the same — the rewrite must not touch `system`.

- [ ] **Step 4: Verify**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Then prove it: change `config.rewriteModel` to `config.chatModel` in the `generateText` call, confirm the relevant test **fails**, restore.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src packages/core/src
git commit -m "feat(core): rewrite the query on the repair round, and pin the provider contract"
```

---

## Definition of Done

- Provider failures have a typed cause, and only cause `schema` becomes `schema_invalid` in the `escalations` table.
- One adapter covers every OpenAI-shaped service; Anthropic has a native adapter with a tested cache point.
- Chat and embedding may come from different providers, and the Anthropic + OpenAI embeddings combination works.
- The resolver builds a provider from the environment, refuses to hand back a provider that can't embed, and **reports** what it chose and why.
- Every adapter passes the same contract test.
- The repair round rewrites the query and re-retrieves, using the previously unused `rewriteModel`.
- Zero new runtime dependencies; zero network calls in tests.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 warnings), `pnpm build` are all green.
