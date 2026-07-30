import type { PromptParts } from "../provider.js"
import type { Candidate, TenantConfig } from "../types.js"

/**
 * Menyusun prompt agar cache LLM mengena. Urutan render adalah tools → system
 * → messages, dan cache berupa prefix match, jadi yang stabil harus di depan
 * dan yang volatil di belakang.
 *
 * Konteks hasil retrieve TIDAK BOLEH masuk `system` — ia berbeda tiap
 * pertanyaan dan akan membatalkan cache di setiap permintaan.
 */
export function buildPrompt(args: {
  config: TenantConfig
  history: { role: "user" | "assistant"; content: string }[]
  candidates: Candidate[]
  question: string
  /**
   * Alasan jawaban sebelumnya ditolak, kalau ini ronde perbaikan. Ditaruh di
   * `currentTurn`, BUKAN di `system` — ia berubah per percobaan, dan menaruhnya di
   * bagian stabil akan membatalkan cache prefix untuk setiap pesan.
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

  // Salinan dangkal: `history` yang dikembalikan tidak boleh berbagi referensi
  // dengan array milik pemanggil, supaya mutasi di hilir tidak membatalkan
  // kestabilan prefix.
  return { system, history: [...history], currentTurn }
}

/**
 * Bagian prompt yang wajib byte-stabil antar pertanyaan dalam percakapan yang
 * sama. Dipakai oleh test regresi cache; jangan memasukkan apa pun yang
 * berubah per permintaan.
 */
export function prefixOf(parts: PromptParts): string {
  return JSON.stringify({ system: parts.system, history: parts.history })
}
