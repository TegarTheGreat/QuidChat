import { validateGrounding } from "./grounding/validator.js"
import { buildPrompt } from "./prompt/builder.js"
import type { Provider } from "./provider.js"
import type { Store } from "./store.js"
import type { EscalationReason, PipelineResult } from "./types.js"

const MAX_ROUNDS = 2
const CANDIDATE_LIMIT = 8

/**
 * Menjawab satu pertanyaan pelanggan, atau menolak.
 *
 * **Kontrak kegagalan — disengaja dan asimetris.**
 *
 * Kegagalan PROVIDER ditangkap dan menjadi penolakan yang tercatat. Alasannya:
 * outage provider bersifat per-pesan, store-nya masih hidup jadi eskalasinya benar
 * tersimpan, dan "kami kehilangan N percakapan karena provider down" memang informasi
 * yang ingin dilihat pemilik bisnis.
 *
 * Kegagalan STORE TIDAK ditangkap — ia dilempar ke pemanggil. Tiga alasan:
 *   1. Nilai `EscalationReason` adalah SINYAL BISNIS yang ditinjau tenant untuk
 *      memperbaiki basis pengetahuannya. Database yang tidak terjangkau bukan sinyal
 *      itu, dan mencatatnya akan mencemari metrik yang justru jadi dasar keputusan.
 *   2. `recordEscalation` sendiri lewat store. Kalau store mati, pencatatan eskalasi
 *      juga gagal — menelan error hanya mengubah satu kegagalan menjadi dua kegagalan
 *      yang sunyi.
 *   3. Lapisan server tetap WAJIB punya penangkap menyeluruh untuk bug dan OOM, jadi
 *      di sinilah tempatnya, bukan di sini.
 *
 * Yang harus dilakukan lapisan server: tangkap, catat ke log operasional (bukan ke
 * `escalations`), balas pengunjung dengan pesan sopan, dan kembalikan 503.
 */
export async function answer(args: {
  store: Store
  provider: Provider
  tenantId: string
  conversationId: string
  history: { role: "user" | "assistant"; content: string }[]
  question: string
}): Promise<PipelineResult> {
  const { store, provider, tenantId, conversationId, history, question } = args
  const config = await store.getTenantConfig(tenantId)

  const refuse = async (reason: EscalationReason): Promise<PipelineResult> => {
    await store.recordEscalation({ tenantId, conversationId, reason })
    return { kind: "refused", text: config.refusalText, reason }
  }

  let embedding: number[]
  try {
    embedding = await provider.embed({ model: config.embeddingModel, text: question })
  } catch {
    return refuse("provider_unavailable")
  }

  const candidates = await store.searchChunks({
    tenantId, query: question, embedding,
    embeddingModel: config.embeddingModel,
    limit: CANDIDATE_LIMIT,
  })

  // Tanpa kandidat, tidak ada yang bisa disitasi. Menolak di sini menghemat
  // satu panggilan LLM yang pasti gagal validasi.
  if (candidates.length === 0) return refuse("no_source")

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prompt = buildPrompt({ config, history, candidates, question })

    let result
    try {
      result = await provider.complete({ model: config.chatModel, prompt })
    } catch {
      return refuse("schema_invalid")
    }

    const verdict = validateGrounding({
      answer: result.answer,
      candidates,
      highRiskTopics: config.highRiskTopics,
    })

    if (verdict.ok) {
      await store.recordAnswer({
        tenantId, conversationId,
        segments: result.answer.segments,
        citedChunkIds: verdict.citedChunkIds,
      })
      return {
        kind: "answered",
        segments: result.answer.segments,
        citedChunkIds: verdict.citedChunkIds,
      }
    }
  }

  return refuse("ungrounded")
}
