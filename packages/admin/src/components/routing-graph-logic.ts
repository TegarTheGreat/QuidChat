import type { RoutingRule, Skill } from "../lib/api"

/**
 * The reachability rules behind the routing graph, kept apart from the drawing so they can be
 * tested without a DOM — and because they are a claim about `router.ts`, not about layout.
 */

export const ROW = 76
export const TOP = 8

export type Row = {
  rule: RoutingRule
  skill: Skill | undefined
  /** Never evaluated: an enabled fallback above it already returned. */
  unreachable: boolean
  /** Accepted by the form, skipped by the router. */
  notImplemented: boolean
}

export function buildRows(rules: RoutingRule[], skills: Skill[]): Row[] {
  const byId = new Map(skills.map((s) => [s.id, s]))
  const ordered = rules.toSorted((a, b) => a.position - b.position)

  let closed = false
  return ordered.map((rule) => {
    const skill = byId.get(rule.skillId)
    const row: Row = {
      rule,
      skill,
      unreachable: closed,
      notImplemented: rule.kind === "semantic" || rule.kind === "llm",
    }
    // Mirrors the router exactly: a fallback whose skill is enabled returns, and nothing after it
    // is ever reached. A disabled rule, or one pointing at a disabled skill, is skipped instead.
    if (rule.enabled && rule.kind === "fallback" && skill?.enabled) closed = true
    return row
  })
}


export { buildRows as buildRowsForTest }
