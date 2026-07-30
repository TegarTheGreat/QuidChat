import { describe, expect, it } from "vitest"
import { route, type RoutingRule, type Skill } from "./router.js"

function skill(overrides: Partial<Skill> & { id: string }): Skill {
  return {
    name: overrides.id, systemPrompt: "", enabled: true, isFallback: false, answerMode: null,
    ...overrides,
  }
}

function rule(overrides: Partial<RoutingRule> & { id: string; skillId: string; position: number }): RoutingRule {
  return { kind: "keyword", pattern: null, enabled: true, ...overrides }
}

describe("route", () => {
  const sales = skill({ id: "sales" })
  const complaints = skill({ id: "complaints" })
  const general = skill({ id: "general", isFallback: true })

  it("evaluates rules in POSITION order, not array order — first match wins", () => {
    // Both rules match the same message. `complaints` sits at the array's SECOND
    // slot but position 0, so if evaluation followed array order instead of
    // `position`, `sales` would incorrectly win.
    const rules: RoutingRule[] = [
      rule({ id: "r-sales", skillId: "sales", position: 1, pattern: "price" }),
      rule({ id: "r-complaints", skillId: "complaints", position: 0, pattern: "price" }),
      rule({ id: "r-fallback", skillId: "general", position: 2, kind: "fallback" }),
    ]
    const result = route({ rules, skills: [sales, complaints, general], message: "what is the price?" })
    expect(result?.id).toBe("complaints")
  })

  it("skips a disabled rule, a rule targeting a deleted skill, and a rule targeting a disabled skill", () => {
    const complaintsDisabled = skill({ id: "complaints", enabled: false })
    const rules: RoutingRule[] = [
      rule({ id: "r-disabled-rule", skillId: "sales", position: 0, pattern: "price", enabled: false }),
      rule({ id: "r-deleted-skill", skillId: "does-not-exist", position: 1, pattern: "price" }),
      rule({ id: "r-disabled-skill", skillId: "complaints", position: 2, pattern: "price" }),
      rule({ id: "r-fallback", skillId: "general", position: 3, kind: "fallback" }),
    ]
    const result = route({
      rules, skills: [sales, complaintsDisabled, general], message: "what is the price?",
    })
    expect(result?.id).toBe("general")
  })

  it("a fallback rule matches ANY message and is terminal", () => {
    const rules: RoutingRule[] = [
      // Would match "refund" but the message below never mentions it — proving the
      // fallback below is what catches this, not a lucky keyword match.
      rule({ id: "r-keyword", skillId: "complaints", position: 0, pattern: "refund" }),
      rule({ id: "r-fallback", skillId: "general", position: 1, kind: "fallback" }),
    ]
    const result = route({ rules, skills: [complaints, general], message: "hi there, just browsing" })
    expect(result?.id).toBe("general")
  })

  it("returns null when nothing matches and there is no fallback rule", () => {
    const rules: RoutingRule[] = [
      rule({ id: "r-keyword", skillId: "sales", position: 0, pattern: "price" }),
    ]
    const result = route({ rules, skills: [sales], message: "hello" })
    expect(result).toBeNull()
  })
})
