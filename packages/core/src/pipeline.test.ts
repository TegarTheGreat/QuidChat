import { describe, expect, it } from "vitest"
import { answer } from "./pipeline.js"
import { ProviderError, type ProviderErrorKind } from "./provider-error.js"
import { DEFAULT_CONFIG, FakeProvider, MemoryStore, ThrowingProvider } from "./testing/fakes.js"
import type { Provider } from "./provider.js"
import type { Candidate, EscalationReason } from "./types.js"

const ctx = { tenantId: "t1", conversationId: "c1", history: [], question: "how long is the warranty?" }
const candidate: Candidate = {
  id: "chunk-1", content: "Official warranty 12 months.", documentTitle: "Policy",
}

describe("answer", () => {
  it("an empty knowledge base produces a refusal, not an answer", async () => {
    const store = new MemoryStore([])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Warranty 2 years.", citations: [] }] },
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
    expect(store.recordedUserTurns).toEqual(["how long is the warranty?"])
    // A refusal still leaves a reply in the transcript.
    expect(store.recordedAnswers).toHaveLength(1)
    expect(store.recordedAnswers[0]!.citedChunkIds).toEqual([])
  })

  it("answers with a citation when the source exists", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Warranty 12 months.", citations: ["chunk-1"] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    if (res.kind === "answered") {
      // The document title travels with the citation. A bare chunk id satisfies the
      // shape of "you can see where this came from" without satisfying its purpose —
      // a visitor shown a UUID learns nothing.
      expect(res.citations).toEqual([{ chunkId: "chunk-1", documentTitle: "Policy" }])
    }
    expect(store.recordedAnswers).toHaveLength(1)
  })

  it("tries a second round when validation fails, then succeeds", async () => {
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Warranty 12 months.", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "Warranty 12 months.", citations: ["chunk-1"] }] },
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

  it("stops after two rounds and refuses", async () => {
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

  it("reports what an ungrounded refusal cost, summed across both rounds", async () => {
    // This is the most expensive outcome in the system: two generations, and nothing
    // reaches the visitor. If a refusal reported no usage, a tenant could produce
    // ungrounded answers indefinitely and no budget would ever stop it, because the
    // spend that funded them was never recorded.
    const store = new MemoryStore([candidate])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("refused")
    // FakeProvider reports 10 input and 5 output tokens per call, and there were two.
    expect(res.usage.inputTokens).toBe(20)
    expect(res.usage.outputTokens).toBe(10)
  })

  it("reports zero generation cost when it refuses before generating", async () => {
    // An empty knowledge base refuses without calling generate at all, so the only cost
    // is the embedding — which the provider does not bill through `complete`.
    const store = new MemoryStore([])
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "x", citations: [] }] },
    ])
    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("refused")
    expect(res.usage.inputTokens).toBe(0)
    expect(res.usage.outputTokens).toBe(0)
    // `null`, not zero: the provider reported nothing, which is different from
    // reporting that nothing was cached.
    expect(res.usage.cachedTokens).toBeNull()
  })

  it("propagates a getTenantConfig failure, does not turn it into a refusal", async () => {
    const store = new MemoryStore([])
    store.getTenantConfig = async () => {
      throw new Error("settings could not be read")
    }
    const provider = new FakeProvider([])
    await expect(answer({ store, provider, ...ctx })).rejects.toThrow("settings could not be read")
    // No escalation is recorded: an infrastructure failure is not a business signal.
    expect(store.recordedEscalations).toEqual([])
  })

  it("propagates a searchChunks failure, does not turn it into a refusal", async () => {
    const store = new MemoryStore([candidate])
    store.searchChunks = async () => {
      throw new Error("database unreachable")
    }
    const provider = new FakeProvider([])
    await expect(answer({ store, provider, ...ctx })).rejects.toThrow("database unreachable")
    expect(store.recordedEscalations).toEqual([])
    // Embedding already happened before the store failed — stated so the boundary is clear.
    expect(provider.embedCalls).toHaveLength(1)
  })

  it("maps every provider failure cause to the correct escalation reason", async () => {
    // The old test only proved that a throwing provider produces `schema_invalid`.
    // That was exactly the flaw: 429 and 503 were recorded the same way, and a
    // business owner reading "model didn't comply with the schema" would rewrite a
    // knowledge base that was never the problem.
    const cases: [ProviderErrorKind | "not-a-ProviderError", EscalationReason][] = [
      ["schema", "schema_invalid"],
      ["rate_limit", "provider_unavailable"],
      ["unavailable", "provider_unavailable"],
      ["auth", "provider_unavailable"],
      ["unknown_model", "provider_unavailable"],
      ["not-a-ProviderError", "provider_unavailable"],
    ]

    for (const [cause, expected] of cases) {
      const store = new MemoryStore([candidate])
      const provider: Provider = {
        id: "broken",
        complete: async () => {
          throw cause === "not-a-ProviderError"
            ? new Error("something we don't recognize")
            : new ProviderError(cause, `failed: ${cause}`)
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
      if (res.kind === "refused") expect(res.reason).toBe(expected)
    }
  })
})

describe("answer — static mode", () => {
  it("answers from an approved canned answer without touching the provider at all", async () => {
    // Spec mandatory test #6. A `calls`/`embedCalls` count of zero could pass by
    // accident if an assertion were mistyped or dropped; a provider that throws on
    // every method makes an accidental call impossible to miss instead.
    const store = new MemoryStore(
      [],
      { ...DEFAULT_CONFIG, answerMode: "static" },
      [], [], {},
      [{ id: "canned-1", question: ctx.question, answer: "Our warranty is 12 months.", status: "approved" }],
    )
    const provider = new ThrowingProvider()

    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    if (res.kind === "answered") {
      expect(res.segments).toEqual([{ kind: "general", text: "Our warranty is 12 months." }])
      // Static mode's citations come from human review at approval time, not from the
      // grounding validator — there is nothing to attach here.
      expect(res.citations).toEqual([])
    }
  })

  it("refuses with no_source on a miss — including when only a DRAFT answer matches — without touching the provider", async () => {
    // Spec mandatory test #7, exercised at the pipeline level: a draft that matches
    // perfectly must still be invisible to `static` mode. `MemoryStore.matchCannedAnswer`
    // mirrors the real store's `status = 'approved'` filter, so this proves the pipeline
    // correctly treats a draft-only match as no match at all.
    const store = new MemoryStore(
      [],
      { ...DEFAULT_CONFIG, answerMode: "static" },
      [], [], {},
      [{ id: "canned-1", question: ctx.question, answer: "Draft text, not yet approved.", status: "draft" }],
    )
    const provider = new ThrowingProvider()

    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("no_source")
    expect(store.recordedEscalations).toEqual(["no_source"])
  })
})

describe("answer — thrifty mode", () => {
  it("answers by quoting the top retrieved chunk verbatim, without ever calling complete", async () => {
    // Spec mandatory test: thrifty still embeds (there's no free semantic match without
    // it) but never generates. An empty `answers` list on FakeProvider means a stray
    // `complete()` call would throw "ran out of answers" instead of silently succeeding.
    const store = new MemoryStore([candidate], { ...DEFAULT_CONFIG, answerMode: "thrifty" })
    const provider = new FakeProvider([])

    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    if (res.kind === "answered") {
      expect(res.segments).toEqual([
        { kind: "business_claim", text: candidate.content, citations: [candidate.id] },
      ])
      expect(res.citations).toEqual([{ chunkId: candidate.id, documentTitle: candidate.documentTitle }])
    }
    expect(provider.calls).toHaveLength(0)
    expect(provider.embedCalls).toHaveLength(1)
  })
})
