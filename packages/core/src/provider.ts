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
  /** Menghasilkan jawaban terstruktur. Melempar `ProviderError` — lihat `ProviderErrorKind`. */
  complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult>
  /**
   * Penyelesaian teks biasa, tanpa schema. Dipakai untuk pekerjaan internal yang
   * hasilnya bukan jawaban pelanggan — menulis ulang query pada ronde perbaikan,
   * misalnya. Sengaja TIDAK mengembalikan `Answer`: keluarannya tidak pernah tayang
   * ke pengunjung, jadi ia tidak perlu dan tidak boleh melewati validator grounding.
   */
  generateText(args: { model: string; system: string; user: string }): Promise<string>
  embed(args: { model: string; text: string }): Promise<number[]>
  capabilities(model: string): Promise<Capabilities>
}
