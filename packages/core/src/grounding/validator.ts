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

  /*
   * An answer whose segments are all blank renders as nothing.
   *
   * `asAnswer` only requires `text` to be a string, and "" is a string, so
   * `{"segments":[{"kind":"general","text":""}]}` passed every check, was recorded as a
   * successful answer, and left the visitor looking at an empty bubble. With a
   * `business_claim` it was worse: an empty bubble carrying a source chip — this product's one
   * promise attached to nothing.
   *
   * Checked across the whole answer rather than per segment, because the harm is a reply with
   * no visible text. One blank segment beside a real one costs the visitor nothing, and failing
   * the turn over it would spend a repair round to fix something nobody can see.
   *
   * Small local models — the ones QuidChat exists to support — produce this often enough that
   * it cannot be treated as impossible.
   */
  if (answer.segments.every((seg) => seg.text.trim() === "")) {
    return { ok: false, violation: "empty_answer", detail: "every segment is blank" }
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
