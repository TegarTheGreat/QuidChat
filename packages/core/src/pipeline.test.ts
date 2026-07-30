import { describe, expect, it } from "vitest"
import { answer } from "./pipeline.js"
import { FakeProvider, MemoryStore } from "./testing/fakes.js"
import type { Provider } from "./provider.js"
import type { Candidate } from "./types.js"

const ctx = { tenantId: "t1", conversationId: "c1", history: [], question: "garansi berapa lama?" }
const candidate: Candidate = {
  id: "chunk-1", content: "Garansi resmi 12 bulan.", documentTitle: "Kebijakan",
}

describe("answer", () => {
  it("KB kosong menghasilkan penolakan, bukan jawaban", async () => {
    const store = new MemoryStore([])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 2 tahun.", citations: [] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("no_source")
    expect(store.recordedEscalations).toEqual(["no_source"])
    // Generate TIDAK BOLEH dipanggil: tanpa kandidat, apa pun yang dihasilkan
    // model pasti gagal validasi, jadi memanggilnya hanya membuang biaya.
    expect(provider.calls).toHaveLength(0)
    // Embedding memang terjadi — retrieval membutuhkannya untuk mengetahui
    // bahwa hasilnya kosong. Dinyatakan eksplisit supaya batas klaim ini jelas.
    expect(provider.embedCalls).toHaveLength(1)
  })

  it("menjawab dengan sitasi saat sumbernya ada", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    if (res.kind === "answered") expect(res.citedChunkIds).toEqual(["chunk-1"])
    expect(store.recordedAnswers).toHaveLength(1)
  })

  it("mencoba ronde kedua saat validasi gagal, lalu berhasil", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(provider.calls).toHaveLength(2)
    expect(res.kind).toBe("answered")
  })

  it("berhenti setelah dua ronde dan menolak", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "x", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    // Maksimum dua panggilan — panggilan ketiga tidak boleh terjadi.
    expect(provider.calls).toHaveLength(2)
    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("ungrounded")
  })

  it("meneruskan kegagalan getTenantConfig, tidak mengubahnya jadi penolakan", async () => {
    const store = new MemoryStore([])
    store.getTenantConfig = async () => {
      throw new Error("settings tidak terbaca")
    }
    const provider = new FakeProvider([])
    await expect(answer({ store, provider, ...ctx })).rejects.toThrow("settings tidak terbaca")
    // Tidak ada eskalasi yang tercatat: kegagalan infrastruktur bukan sinyal bisnis.
    expect(store.recordedEscalations).toEqual([])
  })

  it("meneruskan kegagalan searchChunks, tidak mengubahnya jadi penolakan", async () => {
    const store = new MemoryStore([candidate])
    store.searchChunks = async () => {
      throw new Error("database tidak terjangkau")
    }
    const provider = new FakeProvider([])
    await expect(answer({ store, provider, ...ctx })).rejects.toThrow("database tidak terjangkau")
    expect(store.recordedEscalations).toEqual([])
    // Embedding sudah terjadi sebelum store gagal — dinyatakan supaya batasnya jelas.
    expect(provider.embedCalls).toHaveLength(1)
  })

  it("menolak dengan schema_invalid saat provider melempar", async () => {
    const store = new MemoryStore([candidate])
    const provider: Provider = {
      id: "broken",
      complete: async () => { throw new Error("model tidak mematuhi schema") },
      embed: async () => Array.from({ length: 1536 }, () => 0),
      capabilities: async () => ({
        contextWindow: 1, maxOutput: 1, tools: false, vision: false,
        thinking: false, promptCaching: false as const,
      }),
    }
    const res = await answer({ store, provider, ...ctx })
    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("schema_invalid")
  })
})
