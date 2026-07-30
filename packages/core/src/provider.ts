import type { Answer } from "./types.js"

export type PromptParts = {
  /** Stable per tenant. The first cache breakpoint is placed at the end of this part. */
  system: string
  /** Conversation history, only ever appended to. */
  history: { role: "user" | "assistant"; content: string }[]
  /** The current turn: retrieved context + question. Most volatile. */
  currentTurn: string
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
  answer: Answer
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number | null }
}

export interface Provider {
  readonly id: string
  /** Produces a structured answer. Throws `ProviderError` — see `ProviderErrorKind`. */
  complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult>
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
