export type RoutingRule = {
  id: string
  skillId: string
  position: number
  kind: "keyword" | "semantic" | "llm" | "fallback"
  pattern: string | null
  enabled: boolean
}

export type Skill = {
  id: string
  name: string
  systemPrompt: string
  enabled: boolean
  isFallback: boolean
  /** NULL means inherit the tenant's default answer mode. */
  answerMode: string | null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Case-insensitive keyword match, using the SAME front-guarded pattern as
 * `detectHighRisk` in `grounding/high-risk.ts` — see that file's doc comment for the
 * full rationale. In short: a negative lookbehind guards only the FRONT of the
 * pattern, not the back, so a suffixed form like "refundnya" or "gratisan" still
 * matches, while a word that merely CONTAINS the pattern as an infix — "menghargai"
 * containing "hargai" — does not, because it's preceded by other letters/digits.
 */
function matchesKeyword(pattern: string, message: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(pattern)}`, "iu")
  return re.test(message)
}

/**
 * Evaluates `rules` in `position` order against `message` and returns the first
 * matching, enabled skill — or `null` if nothing matched.
 *
 * A rule is skipped, not just its match ignored, when:
 *   - the rule itself is `enabled: false`
 *   - the rule's target skill doesn't exist in `skills` (deleted) or exists but is
 *     `enabled: false` — per spec §10, a routing rule pointing at a deleted/disabled
 *     skill is flagged in the panel and skipped during evaluation, not treated as a
 *     dead end for the whole message.
 *
 * `kind: "fallback"` always matches and is terminal — it's the guaranteed last rule
 * every tenant has, so this function can always find a destination as long as at
 * least one enabled fallback rule points at an enabled skill.
 *
 * `kind: "semantic"` and `kind: "llm"` are NOT evaluated here. Both require calling
 * out (an embedding call, a classification call) which this pure function must not
 * do — they belong to a later pass that wraps this one with those calls. Here they
 * are treated as non-matching, so evaluation simply falls through to the next rule.
 */
/**
 * TWO DIFFERENT FALLBACKS, and confusing them is easy.
 *
 * A routing rule of kind `fallback` always matches and is terminal — it is how a tenant
 * says "anything not matched above goes here". Routing uses only rules, so a tenant with
 * no fallback RULE gets `null` for an unmatched message, and the pipeline then retrieves
 * across all of the tenant's sources. That is the right default: an unrouted question
 * should see everything rather than nothing.
 *
 * `skills.is_fallback` is separate. It marks the skill that HANDOFF goes to when a routed
 * skill finds nothing in its own sources. A skill can be a handoff target without any rule
 * pointing at it, and a rule can point at a skill that is not a handoff target.
 */
export function route(args: { rules: RoutingRule[]; skills: Skill[]; message: string }): Skill | null {
  const skillById = new Map(args.skills.map((s) => [s.id, s]))
  const ordered = args.rules.toSorted((a, b) => a.position - b.position)

  for (const rule of ordered) {
    if (!rule.enabled) continue
    const skill = skillById.get(rule.skillId)
    if (!skill || !skill.enabled) continue

    switch (rule.kind) {
      case "fallback":
        return skill
      case "keyword":
        if (rule.pattern !== null && matchesKeyword(rule.pattern, args.message)) return skill
        break
      case "semantic":
      case "llm":
        // Deferred to a later pass — see doc comment above.
        break
    }
  }

  return null
}
