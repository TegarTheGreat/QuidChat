import { describe, expect, it } from "vitest"
import { validateGrounding } from "./validator.js"
import type { Candidate } from "../types.js"

const TOPICS = ["price", "discount", "warranty", "refund", "stock", "legal"]
const candidates: Candidate[] = [
  { id: "chunk-1", content: "Official warranty 12 months.", documentTitle: "Policy" },
  { id: "chunk-2", content: "Price $200,000.", documentTitle: "Catalog" },
]

const run = (segments: Parameters<typeof validateGrounding>[0]["answer"]["segments"]) =>
  validateGrounding({ answer: { segments }, candidates, highRiskTopics: TOPICS })

describe("validateGrounding", () => {
  it("rejects a business claim without a citation", () => {
    const v = run([{ kind: "business_claim", text: "Warranty 12 months.", citations: [] }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("missing_citation")
  })

  it("rejects a citation outside the candidateSet", () => {
    const v = run([
      { kind: "business_claim", text: "Warranty 12 months.", citations: ["chunk-99"] },
    ])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unknown_citation")
  })

  it("rejects a general segment that mentions a high-risk topic", () => {
    const v = run([{ kind: "general", text: "Our price is the cheapest around." }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unlabelled_high_risk")
  })

  it("passes a business claim with a valid citation", () => {
    const v = run([
      { kind: "business_claim", text: "Warranty 12 months.", citations: ["chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual(["chunk-1"])
  })

  it("passes a greeting labelled general", () => {
    const v = run([{ kind: "general", text: "Hello! Sure, I can help." }])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual([])
  })

  it("collects unique citations from multiple segments", () => {
    const v = run([
      { kind: "general", text: "Hello!" },
      { kind: "business_claim", text: "Warranty 12 months.", citations: ["chunk-1"] },
      { kind: "business_claim", text: "The price is $200,000.", citations: ["chunk-2", "chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    // `toSorted()` not `sort()`: the latter would mutate the array inside the
    // verdict, so a later assertion in the same test would be checking data
    // whose order was already scrambled by the earlier assertion.
    if (v.ok) expect(v.citedChunkIds.toSorted()).toEqual(["chunk-1", "chunk-2"])
  })

  it("rejects an empty answer", () => {
    const v = run([])
    expect(v.ok).toBe(false)
    // The violation is checked too. Without this, an implementation that rejects an
    // empty answer with the wrong label — `missing_citation`, say — would still pass,
    // and a caller branching on the rejection reason would branch incorrectly.
    if (!v.ok) expect(v.violation).toBe("empty_answer")
  })
})

describe("an answer that renders as nothing", () => {
  const sources = [{ id: "c1", content: "Warranty is 12 months.", documentTitle: "Policy" }]

  it("rejects a reply whose only segment is empty", () => {
    // `asAnswer` accepts "" because it is a string, and this used to pass validation, be
    // recorded as a success, and leave the visitor looking at an empty bubble.
    const verdict = validateGrounding({
      answer: { segments: [{ kind: "general", text: "" }] },
      candidates: sources,
      highRiskTopics: [],
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.violation).toBe("empty_answer")
  })

  it("rejects a blank business claim even when it carries a valid citation", () => {
    // The worse shape: an empty bubble with a source chip attached — the product's one promise
    // pointing at nothing.
    const verdict = validateGrounding({
      answer: { segments: [{ kind: "business_claim", text: "   \n ", citations: ["c1"] }] },
      candidates: sources,
      highRiskTopics: [],
    })
    expect(verdict.ok).toBe(false)
  })

  it("keeps an answer that has real text beside a blank segment", () => {
    // The harm is a reply with nothing visible in it. A stray empty segment next to a real one
    // costs the visitor nothing, and failing the turn would spend a repair round on it.
    const verdict = validateGrounding({
      answer: {
        segments: [
          { kind: "general", text: "" },
          { kind: "business_claim", text: "Warranty is 12 months.", citations: ["c1"] },
        ],
      },
      candidates: sources,
      highRiskTopics: [],
    })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.citedChunkIds).toEqual(["c1"])
  })
})
