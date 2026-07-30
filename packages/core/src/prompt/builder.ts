import type { PromptParts } from "../provider.js"
import type { Candidate, TenantConfig } from "../types.js"

/**
 * Assembles the prompt so the LLM cache hits. Render order is tools → system
 * → messages, and caching is a prefix match, so what's stable must come first
 * and what's volatile must come last.
 *
 * Retrieved context must NEVER go into `system` — it differs per question and
 * would invalidate the cache on every request, with no error and no log.
 */
export function buildPrompt(args: {
  config: TenantConfig
  history: { role: "user" | "assistant"; content: string }[]
  candidates: Candidate[]
  question: string
  /**
   * Why the previous answer was rejected, if this is a repair round. Placed in
   * `currentTurn`, NOT in `system` — it changes per attempt, and putting it in the
   * stable part would invalidate the prefix cache for every message.
   */
  feedback?: string
}): PromptParts {
  const { config, history, candidates, question, feedback } = args

  const system = [
    "You are a customer service assistant for a business.",
    "",
    "Rules that cannot be broken:",
    "- Every statement about this business (price, stock, warranty, policy,",
    "  opening hours, availability) may ONLY come from the provided context,",
    "  and must carry its source id.",
    "- Greetings, thanks, and general help need no source.",
    "- If the context does not contain the answer, do not guess. Say:",
    `  "${config.refusalText}"`,
    "",
    `Topics that are always treated as business statements: ${config.highRiskTopics.join(", ")}.`,
    "",
    "Reply as JSON with the shape:",
    '{"segments":[{"text":"...","kind":"general"},',
    ' {"text":"...","kind":"business_claim","citations":["<id>"]}]}',
  ].join("\n")

  const contextBlock = candidates.length === 0
    ? "(no relevant context)"
    : candidates
        .map((c) => `[${c.id}] (${c.documentTitle})\n${c.content}`)
        .join("\n\n")

  const currentTurn = [
    "<context>",
    contextBlock,
    "</context>",
    "",
    ...(feedback
      ? [
          "<repair>",
          `Previous answer was REJECTED: ${feedback}`,
          "Fix it by citing an id from <context> above for every business claim,",
          "or give the refusal text if the context truly does not contain the answer.",
          "</repair>",
          "",
        ]
      : []),
    `Customer question: ${question}`,
  ].join("\n")

  // Shallow copy: the returned `history` must not share a reference with the
  // caller's array, so a downstream mutation can't undo the prefix's
  // stability.
  return { system, history: [...history], currentTurn }
}

/**
 * The part of the prompt that must be byte-stable across questions within the
 * same conversation. Used by the cache regression test; don't include anything
 * that changes per request.
 */
export function prefixOf(parts: PromptParts): string {
  return JSON.stringify({ system: parts.system, history: parts.history })
}
