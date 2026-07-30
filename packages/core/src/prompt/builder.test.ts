import { describe, expect, it, vi } from "vitest"
import { buildPrompt, prefixOf } from "./builder.js"
import type { Candidate, TenantConfig } from "../types.js"

const config: TenantConfig = {
  chatModel: "claude-opus-5",
  rewriteModel: "claude-opus-5",
  embeddingModel: "text-embedding-3-small",
  refusalText: "Sorry, I don't have that information yet.",
  highRiskTopics: ["price", "warranty"],
}

const history = [
  { role: "user" as const, content: "hello" },
  { role: "assistant" as const, content: "Hello! How can I help?" },
]

const c = (id: string, content: string): Candidate =>
  ({ id, content, documentTitle: "Catalog" })

describe("buildPrompt", () => {
  it("the prefix is byte-identical for different questions", () => {
    const a = buildPrompt({ config, history, candidates: [c("k1", "Warranty 12 months")], question: "warranty?" })
    const b = buildPrompt({ config, history, candidates: [c("k2", "Price $200")], question: "price?" })
    expect(prefixOf(a)).toBe(prefixOf(b))
  })

  it("the prefix changes when tenant configuration changes", () => {
    const a = buildPrompt({ config, history, candidates: [], question: "x" })
    const b = buildPrompt({
      config: { ...config, refusalText: "different" },
      history, candidates: [], question: "x",
    })
    expect(prefixOf(a)).not.toBe(prefixOf(b))
  })

  it("retrieved context goes into the current turn, not system", () => {
    const p = buildPrompt({
      config, history,
      candidates: [c("k1", "Official warranty 12 months")],
      question: "how long is the warranty?",
    })
    expect(p.system).not.toContain("Official warranty 12 months")
    expect(p.currentTurn).toContain("Official warranty 12 months")
  })

  it("includes the chunk id so the model can cite it", () => {
    const p = buildPrompt({ config, history, candidates: [c("k1", "content")], question: "q" })
    expect(p.currentTurn).toContain("k1")
  })

  it("system prompt contains the refusal text and the tenant's high-risk topic list", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.system).toContain("Sorry, I don't have that information yet.")
    // Assertion on the interpolated sentence, NOT just on the word "price".
    // That word also appears in the static rules text, so `toContain("price")`
    // would still pass even if `config.highRiskTopics` was never rendered at
    // all — an assertion that proves nothing.
    expect(p.system).toContain("Topics that are always treated as business statements: price, warranty.")
  })

  it("history is passed through as-is, but is not the caller's own array", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.history).toEqual(history)
    expect(p.history).not.toBe(history)
  })

  it("the prefix stays identical even when time passes between calls", () => {
    // This is the regression spec §11.1 cites as the reason this test exists: a single
    // `new Date()` in the system prompt would invalidate the cache on every message,
    // with no error and no log. A test without a fake clock would NOT catch it — two
    // calls would land in the same millisecond, so the timestamps would coincidentally
    // match and the prefix would still compare equal.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const a = buildPrompt({ config, history, candidates: [c("k1", "content")], question: "q1" })
      vi.advanceTimersByTime(60 * 60 * 1000) // one hour
      const b = buildPrompt({ config, history, candidates: [c("k2", "other")], question: "q2" })
      expect(prefixOf(a)).toBe(prefixOf(b))
    } finally {
      vi.useRealTimers()
    }
  })
})
