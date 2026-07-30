import type { Answer, Candidate } from "../types.js"
import { detectHighRisk } from "./high-risk.js"

export type GroundingVerdict =
  | { ok: true; citedChunkIds: string[] }
  | {
      ok: false
      violation: "missing_citation" | "unknown_citation" | "unlabelled_high_risk" | "empty_answer"
      detail: string
    }

export function validateGrounding(args: {
  answer: Answer
  candidates: Candidate[]
  highRiskTopics: string[]
}): GroundingVerdict {
  const { answer, candidates, highRiskTopics } = args

  if (answer.segments.length === 0) {
    return { ok: false, violation: "empty_answer", detail: "no segments" }
  }

  const allowed = new Set(candidates.map((c) => c.id))
  const cited = new Set<string>()

  for (const seg of answer.segments) {
    if (seg.kind === "general") {
      // The model's own labeling is not trusted for high-risk topics.
      const risky = detectHighRisk(seg.text, highRiskTopics)
      if (risky.length > 0) {
        return {
          ok: false,
          violation: "unlabelled_high_risk",
          detail: `general segment mentions: ${risky.join(", ")}`,
        }
      }
      continue
    }

    if (seg.citations.length === 0) {
      return {
        ok: false,
        violation: "missing_citation",
        detail: `business claim without citation: ${seg.text.slice(0, 60)}`,
      }
    }

    for (const id of seg.citations) {
      // Validated against the candidateSet, not against the database. The model
      // could make up an id that's real but was never retrieved.
      if (!allowed.has(id)) {
        return {
          ok: false,
          violation: "unknown_citation",
          detail: `citation outside candidateSet: ${id}`,
        }
      }
      cited.add(id)
    }
  }

  return { ok: true, citedChunkIds: [...cited] }
}
