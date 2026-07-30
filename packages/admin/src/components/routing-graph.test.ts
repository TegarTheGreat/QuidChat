import { describe, expect, it } from "vitest"
import { buildRowsForTest as buildRows } from "./routing-graph-logic.js"
import type { RoutingRule, Skill } from "../lib/api"

function skill(id: string, over: Partial<Skill> = {}): Skill {
  return {
    id, name: id, description: null, systemPrompt: null,
    enabled: true, isFallback: false, answerMode: null, sources: [], ...over,
  }
}
function rule(id: string, skillId: string, position: number, over: Partial<RoutingRule> = {}): RoutingRule {
  return { id, skillId, position, kind: "keyword", pattern: "x", enabled: true, ...over }
}

describe("what the graph can tell an owner that the table cannot", () => {
  it("marks every rule below an enabled fallback as never running", () => {
    // The router returns unconditionally on a fallback whose skill is enabled. A keyword rule
    // added underneath will never fire, and nothing in the table says so — the owner just sees
    // an assistant ignoring a rule they configured.
    const skills = [skill("sales"), skill("billing")]
    const rows = buildRows(
      [rule("r1", "sales", 1, { kind: "fallback", pattern: null }), rule("r2", "billing", 2)],
      skills,
    )
    expect(rows[0]!.unreachable).toBe(false)
    expect(rows[1]!.unreachable).toBe(true)
  })

  it("does not close the ladder on a fallback that cannot fire", () => {
    // A disabled fallback, or one pointing at a disabled skill, is skipped by the router — so the
    // rules below it DO run. Marking them dead would send an owner deleting working rules.
    const disabledRule = buildRows(
      [rule("r1", "sales", 1, { kind: "fallback", pattern: null, enabled: false }), rule("r2", "billing", 2)],
      [skill("sales"), skill("billing")],
    )
    expect(disabledRule[1]!.unreachable).toBe(false)

    const disabledSkill = buildRows(
      [rule("r1", "sales", 1, { kind: "fallback", pattern: null }), rule("r2", "billing", 2)],
      [skill("sales", { enabled: false }), skill("billing")],
    )
    expect(disabledSkill[1]!.unreachable).toBe(false)
  })

  it("flags the rule kinds the router silently skips", () => {
    // The form accepts these; the router breaks past them. Never matching with no explanation is
    // the worst version of "deferred".
    const rows = buildRows(
      [
        rule("r1", "s", 1, { kind: "semantic" }),
        rule("r2", "s", 2, { kind: "llm" }),
        rule("r3", "s", 3, { kind: "keyword" }),
      ],
      [skill("s")],
    )
    expect(rows.map((r) => r.notImplemented)).toEqual([true, true, false])
  })

  it("reads the ladder in position order, not the order the rows arrived in", () => {
    const rows = buildRows(
      [rule("r2", "b", 2), rule("r1", "a", 1, { kind: "fallback", pattern: null })],
      [skill("a"), skill("b")],
    )
    expect(rows.map((r) => r.rule.id)).toEqual(["r1", "r2"])
    expect(rows[1]!.unreachable).toBe(true)
  })
})
