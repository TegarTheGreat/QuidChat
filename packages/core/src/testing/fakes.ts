import type { Capabilities, CompleteResult, Provider, PromptParts } from "../provider.js"
import type { Store } from "../store.js"
import type { Answer, Candidate, EscalationReason, Segment, TenantConfig } from "../types.js"

export const DEFAULT_CONFIG: TenantConfig = {
  chatModel: "fake-model",
  rewriteModel: "fake-model",
  embeddingModel: "fake-embedding-model",
  refusalText: "Maaf, saya belum punya informasi itu.",
  highRiskTopics: ["harga", "diskon", "garansi", "refund", "stok", "legal"],
}

/**
 * Some methods below deliberately declare fewer parameters than `Store` —
 * TypeScript allows it, and writing out unused parameters would only add
 * noise. The shape the pipeline calls stays the same.
 */
export class MemoryStore implements Store {
  recordedAnswers: { segments: Segment[]; citedChunkIds: string[] }[] = []
  recordedEscalations: EscalationReason[] = []
  recordedUserTurns: string[] = []

  constructor(
    private candidates: Candidate[] = [],
    private config: TenantConfig = DEFAULT_CONFIG,
  ) {}

  async getTenantConfig(): Promise<TenantConfig> {
    return this.config
  }

  async searchChunks(): Promise<Candidate[]> {
    return this.candidates
  }

  async recordAnswer(args: { segments: Segment[]; citedChunkIds: string[] }): Promise<void> {
    this.recordedAnswers.push({ segments: args.segments, citedChunkIds: args.citedChunkIds })
  }

  async recordEscalation(args: { reason: EscalationReason }): Promise<void> {
    this.recordedEscalations.push(args.reason)
  }

  async recordUserTurn(args: { text: string }): Promise<void> {
    this.recordedUserTurns.push(args.text)
  }
}

/** Provider that returns answers from a prepared list, one per call. */
export class FakeProvider implements Provider {
  readonly id = "fake"
  /** Generate calls. Kept separate from `embedCalls` so a test can assert
   *  precisely which cost happened and which didn't. */
  calls: PromptParts[] = []
  embedCalls: string[] = []
  textCalls: { system: string; user: string }[] = []
  /** The reply `generateText` returns, settable by a test. */
  textReply = "pertanyaan yang ditulis ulang"

  constructor(private answers: Answer[]) {}

  async complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult> {
    this.calls.push(args.prompt)
    const next = this.answers[this.calls.length - 1] ?? this.answers.at(-1)
    if (!next) throw new Error("FakeProvider kehabisan jawaban")
    return {
      answer: next,
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: null },
    }
  }

  async generateText(args: { model: string; system: string; user: string }): Promise<string> {
    this.textCalls.push({ system: args.system, user: args.user })
    return this.textReply
  }

  async embed(args: { model: string; text: string }): Promise<number[]> {
    this.embedCalls.push(args.text)
    return Array.from({ length: 1536 }, () => 0)
  }

  async capabilities(): Promise<Capabilities> {
    return {
      contextWindow: 200_000, maxOutput: 16_000,
      tools: true, vision: false, thinking: false,
      promptCaching: { minPrefixTokens: 1024, maxBreakpoints: 4 },
    }
  }
}
