import { validateGrounding } from "./grounding/validator.js"
import { buildPrompt } from "./prompt/builder.js"
import { ProviderError } from "./provider-error.js"
import type { Provider } from "./provider.js"
import type { Store } from "./store.js"
import type { EscalationReason, PipelineResult } from "./types.js"

const MAX_ROUNDS = 2
const CANDIDATE_LIMIT = 8

/**
 * Menerjemahkan kegagalan provider ke alasan eskalasi. Bukan `schema_invalid` untuk
 * semuanya — lihat `ProviderErrorKind` untuk alasan mengapa perbedaannya penting.
 * Error yang BUKAN `ProviderError` diperlakukan sebagai tidak tersedia, bukan sebagai
 * pelanggaran schema: kita tidak tahu sebabnya, dan menuduh model lebih buruk daripada
 * mengakui ketidaktahuan.
 */
function alasanDari(e: unknown): EscalationReason {
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

  await store.recordUserTurn({ tenantId, conversationId, text: question })

  const refuse = async (reason: EscalationReason): Promise<PipelineResult> => {
    await store.recordEscalation({ tenantId, conversationId, reason })
    // Teks penolakan ikut masuk transkrip. Tanpa ini, tenant yang membuka percakapan
    // untuk mencari tahu mengapa bot eskalasi hanya melihat pertanyaan tanpa balasan,
    // dan widget yang memutar ulang riwayat kehilangan separuh percakapan.
    await store.recordAnswer({
      tenantId, conversationId,
      segments: [{ kind: "general", text: config.refusalText }],
      citedChunkIds: [],
    })
    return { kind: "refused", text: config.refusalText, reason }
  }

  let embedding: number[]
  try {
    embedding = await provider.embed({ model: config.embeddingModel, text: question })
  } catch (e) {
    return refuse(alasanDari(e))
  }

  const candidates = await store.searchChunks({
    tenantId, query: question, embedding,
    embeddingModel: config.embeddingModel,
    limit: CANDIDATE_LIMIT,
  })

  // Tanpa kandidat, tidak ada yang bisa disitasi. Menolak di sini menghemat
  // satu panggilan LLM yang pasti gagal validasi.
  if (candidates.length === 0) return refuse("no_source")

  let feedback: string | undefined
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prompt = buildPrompt({ config, history, candidates, question, ...(feedback ? { feedback } : {}) })

    let result
    try {
      result = await provider.complete({ model: config.chatModel, prompt })
    } catch (e) {
      return refuse(alasanDari(e))
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

    // Alasan penolakan dibawa ke ronde berikutnya. Tanpa ini ronde 2 mengirim prompt
    // yang IDENTIK, dan model bertemperature 0 mengembalikan jawaban yang identik —
    // biaya dua kali untuk duplikat yang terjamin.
    feedback = `${verdict.violation} — ${verdict.detail}`
  }

  return refuse("ungrounded")
}
