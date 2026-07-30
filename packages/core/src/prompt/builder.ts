import type { PromptParts } from "../provider.js"
import type { Candidate, TenantConfig } from "../types.js"

/**
 * Assembles the prompt so the LLM cache hits. Render order is tools → system
 * → messages, and caching is a prefix match, so what's stable must come first
 * and what's volatile must come last.
 *
 * Retrieved context must NEVER go into `system` — it differs per question and
 * would invalidate the cache on every request, with no error and no log.
 */
export function buildPrompt(args: {
  config: TenantConfig
  history: { role: "user" | "assistant"; content: string }[]
  candidates: Candidate[]
  question: string
  /**
   * Why the previous answer was rejected, if this is a repair round. Placed in
   * `currentTurn`, NOT in `system` — it changes per attempt, and putting it in the
   * stable part would invalidate the prefix cache for every message.
   */
  feedback?: string
}): PromptParts {
  const { config, history, candidates, question, feedback } = args

  const system = [
    "Kamu adalah asisten layanan pelanggan untuk sebuah bisnis.",
    "",
    "Aturan yang tidak bisa dilanggar:",
    "- Setiap pernyataan tentang bisnis ini (harga, stok, garansi, kebijakan,",
    "  jam operasional, ketersediaan) HANYA boleh berasal dari konteks yang",
    "  diberikan, dan wajib menyertakan id sumbernya.",
    "- Sapaan, ucapan terima kasih, dan bantuan umum tidak perlu sumber.",
    "- Bila konteks tidak memuat jawabannya, jangan menebak. Sampaikan:",
    `  "${config.refusalText}"`,
    "",
    `Topik yang selalu dianggap pernyataan bisnis: ${config.highRiskTopics.join(", ")}.`,
    "",
    "Balas sebagai JSON dengan bentuk:",
    '{"segments":[{"text":"...","kind":"general"},',
    ' {"text":"...","kind":"business_claim","citations":["<id>"]}]}',
  ].join("\n")

  const contextBlock = candidates.length === 0
    ? "(tidak ada konteks yang relevan)"
    : candidates
        .map((c) => `[${c.id}] (${c.documentTitle})\n${c.content}`)
        .join("\n\n")

  const currentTurn = [
    "<konteks>",
    contextBlock,
    "</konteks>",
    "",
    ...(feedback
      ? [
          "<perbaikan>",
          `Jawaban sebelumnya DITOLAK: ${feedback}`,
          "Perbaiki dengan menyitasi id dari <konteks> di atas untuk setiap klaim bisnis,",
          "atau sampaikan teks penolakan bila konteksnya memang tidak memuat jawabannya.",
          "</perbaikan>",
          "",
        ]
      : []),
    `Pertanyaan pelanggan: ${question}`,
  ].join("\n")

  // Shallow copy: the returned `history` must not share a reference with the
  // caller's array, so a downstream mutation can't undo the prefix's
  // stability.
  return { system, history: [...history], currentTurn }
}

/**
 * The part of the prompt that must be byte-stable across questions within the
 * same conversation. Used by the cache regression test; don't include anything
 * that changes per request.
 */
export function prefixOf(parts: PromptParts): string {
  return JSON.stringify({ system: parts.system, history: parts.history })
}
