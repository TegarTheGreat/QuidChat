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
    return { ok: false, violation: "empty_answer", detail: "tidak ada segmen" }
  }

  const allowed = new Set(candidates.map((c) => c.id))
  const cited = new Set<string>()

  for (const seg of answer.segments) {
    if (seg.kind === "general") {
      // Label dari model tidak dipercaya untuk topik berisiko tinggi.
      const risky = detectHighRisk(seg.text, highRiskTopics)
      if (risky.length > 0) {
        return {
          ok: false,
          violation: "unlabelled_high_risk",
          detail: `segmen general menyebut: ${risky.join(", ")}`,
        }
      }
      continue
    }

    if (seg.citations.length === 0) {
      return {
        ok: false,
        violation: "missing_citation",
        detail: `klaim bisnis tanpa sitasi: ${seg.text.slice(0, 60)}`,
      }
    }

    for (const id of seg.citations) {
      // Divalidasi terhadap candidateSet, bukan terhadap database. Model bisa
      // mengarang id yang nyata tapi tidak pernah di-retrieve.
      if (!allowed.has(id)) {
        return {
          ok: false,
          violation: "unknown_citation",
          detail: `sitasi di luar candidateSet: ${id}`,
        }
      }
      cited.add(id)
    }
  }

  return { ok: true, citedChunkIds: [...cited] }
}
