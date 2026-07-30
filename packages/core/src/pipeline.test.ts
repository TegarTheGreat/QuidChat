import { describe, expect, it } from "vitest"
import { answer } from "./pipeline.js"
import { ProviderError, type ProviderErrorKind } from "./provider-error.js"
import { FakeProvider, MemoryStore } from "./testing/fakes.js"
import type { Provider } from "./provider.js"
import type { Candidate, EscalationReason } from "./types.js"

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
    // Generate must NOT be called: without candidates, whatever the model produces
    // is guaranteed to fail validation, so calling it would only waste money.
    expect(provider.calls).toHaveLength(0)
    // Embedding does happen — retrieval needs it to know the result is empty.
    // Stated explicitly so the boundary of this claim is clear.
    expect(provider.embedCalls).toHaveLength(1)
    expect(store.recordedUserTurns).toEqual(["garansi berapa lama?"])
    // A refusal still leaves a reply in the transcript.
    expect(store.recordedAnswers).toHaveLength(1)
    expect(store.recordedAnswers[0]!.citedChunkIds).toEqual([])
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
    // Round two must carry a DIFFERENT prompt. This is the assertion that failed on
    // the earlier version, when round 2 was a byte-identical resample.
    expect(provider.calls[1]!.currentTurn).not.toBe(provider.calls[0]!.currentTurn)
    expect(provider.calls[1]!.currentTurn).toContain("missing_citation")
    // But the PREFIX must stay the same, otherwise the cache is invalidated.
    expect(provider.calls[1]!.system).toBe(provider.calls[0]!.system)
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

    // Maximum of two calls — a third call must not happen.
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
    // No escalation is recorded: an infrastructure failure is not a business signal.
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
    // Embedding already happened before the store failed — stated so the boundary is clear.
    expect(provider.embedCalls).toHaveLength(1)
  })

  it("memetakan setiap sebab kegagalan provider ke alasan eskalasi yang benar", async () => {
    // The old test only proved that a throwing provider produces `schema_invalid`.
    // That was exactly the flaw: 429 and 503 were recorded the same way, and a
    // business owner reading "model didn't comply with the schema" would rewrite a
    // knowledge base that was never the problem.
    const kasus: [ProviderErrorKind | "bukan-ProviderError", EscalationReason][] = [
      ["schema", "schema_invalid"],
      ["rate_limit", "provider_unavailable"],
      ["unavailable", "provider_unavailable"],
      ["auth", "provider_unavailable"],
      ["unknown_model", "provider_unavailable"],
      ["bukan-ProviderError", "provider_unavailable"],
    ]

    for (const [sebab, diharapkan] of kasus) {
      const store = new MemoryStore([candidate])
      const provider: Provider = {
        id: "rusak",
        complete: async () => {
          throw sebab === "bukan-ProviderError"
            ? new Error("sesuatu yang tidak kami kenali")
            : new ProviderError(sebab, `gagal: ${sebab}`)
        },
        generateText: async () => "",
        embed: async () => Array.from({ length: 1536 }, () => 0),
        capabilities: async () => ({
          contextWindow: 1, maxOutput: 1, tools: false, vision: false,
          thinking: false, promptCaching: false as const,
        }),
      }
      const res = await answer({ store, provider, ...ctx })
      expect(res.kind).toBe("refused")
      if (res.kind === "refused") expect(res.reason).toBe(diharapkan)
    }
  })
})
