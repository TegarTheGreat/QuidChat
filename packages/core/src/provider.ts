import type { Answer } from "./types.js"

export type PromptParts = {
  /** Stable per tenant. The first cache breakpoint is placed at the end of this part. */
  system: string
  /** Conversation history, only ever appended to. */
  history: { role: "user" | "assistant"; content: string }[]
  /** The current turn: retrieved context + question. Most volatile. */
  currentTurn: string
}

/**
 * A tool the model may call instead of answering.
 *
 * The one tool QuidChat defines is `handoff` — the moment a skill recognises a question is not
 * its territory and passes it to the sibling that owns it. That is the difference between an
 * assistant that refuses because the Sales persona has no billing documents and one that says so
 * and moves the customer to Billing.
 */
export type ToolDefinition = {
  name: string
  /** What the model reads to decide whether this is the moment. Written for the model. */
  description: string
  /** JSON Schema for the arguments. Enums here are what stop the model inventing a target. */
  parameters: Record<string, unknown>
}

/** A call the model made. `input` is parsed but NOT validated — the caller owns the schema. */
export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type Capabilities = {
  contextWindow: number
  maxOutput: number
  tools: boolean
  vision: boolean
  thinking: boolean
  promptCaching: false | { minPrefixTokens: number; maxBreakpoints: number }
}

export type CompleteResult = {
  /**
   * Null exactly when the model called a tool instead of answering.
   *
   * Nullable rather than a placeholder answer so the compiler makes every caller decide what to
   * do with a tool call. A caller that read a stand-in answer would send a customer an empty
   * reply and record it as a success.
   */
  answer: Answer | null
  /** Empty on a normal answer. */
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number | null }
}

export interface Provider {
  readonly id: string
  /** Produces a structured answer. Throws `ProviderError` — see `ProviderErrorKind`. */
  /**
   * `tools` is passed identically for every skill in a tenant, on purpose: tools render before
   * the system prompt, so a tool list that varies per skill moves the cache breakpoint to
   * position 0 and re-bills the whole prefix on every handoff. Which targets are actually
   * reachable is stated in the system prompt, not by changing the list.
   */
  complete(args: {
    model: string
    prompt: PromptParts
    tools?: ToolDefinition[]
  }): Promise<CompleteResult>
  /**
   * Plain-text completion, no schema. Used for internal work whose output is not a
   * customer-facing answer — rewriting the query on a repair round, for example.
   * Deliberately does NOT return an `Answer`: its output never reaches a visitor, so
   * it must not, and need not, pass through the grounding validator.
   */
  generateText(args: { model: string; system: string; user: string }): Promise<string>
  embed(args: { model: string; text: string }): Promise<number[]>
  capabilities(model: string): Promise<Capabilities>
}
