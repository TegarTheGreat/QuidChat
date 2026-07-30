import type { Answer } from "./types.js"

export type PromptParts = {
  /** Stabil per tenant. Titik cache pertama diletakkan di akhir bagian ini. */
  system: string
  /** Riwayat percakapan, hanya bertambah di ujung. */
  history: { role: "user" | "assistant"; content: string }[]
  /** Turn sekarang: konteks hasil retrieve + pertanyaan. Paling volatil. */
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
  /** Menghasilkan jawaban terstruktur. Melempar bila model gagal mematuhi schema. */
  complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult>
  embed(args: { model: string; text: string }): Promise<number[]>
  capabilities(model: string): Promise<Capabilities>
}
