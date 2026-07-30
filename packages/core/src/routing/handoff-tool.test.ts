import { describe, expect, it } from "vitest"
import { handoffTool, pairAlreadyUsed, resolveHandoff, HANDOFF_TOOL_NAME } from "./handoff-tool.js"
import type { Skill } from "./router.js"

function skill(over: Partial<Skill> & { id: string; name: string }): Skill {
  return { enabled: true, isFallback: false, systemPrompt: "", ...over } as Skill
}

const sales = skill({ id: "s1", name: "Sales" })
const billing = skill({ id: "s2", name: "Billing" })
const retired = skill({ id: "s3", name: "Retired", enabled: false })

describe("the handoff tool's shape", () => {
  it("offers only skills that exist, so a target cannot be invented", () => {
    const tool = handoffTool([sales, billing, retired])!
    const properties = tool.parameters.properties as { to: { enum: string[] } }

    expect(tool.name).toBe(HANDOFF_TOOL_NAME)
    expect(properties.to.enum).toEqual(["Sales", "Billing"])
    // A disabled skill in the enum is a target the model can pick and the code must then reject —
    // a refusal the customer sees for a reason that is nobody's fault.
    expect(properties.to.enum).not.toContain("Retired")
  })

  it("does not exist when there is nobody to hand off to", () => {
    // A tool the model cannot legally use still costs tokens on every single request.
    expect(handoffTool([sales])).toBeNull()
    expect(handoffTool([])).toBeNull()
    expect(handoffTool([sales, retired])).toBeNull()
  })

  it("is the same list whichever skill is answering", () => {
    // Tools render before the system prompt. A list that varied per skill would move the first
    // cache breakpoint to position 0 and re-bill the entire prefix on every handoff.
    const fromSales = handoffTool([sales, billing])
    const fromBilling = handoffTool([sales, billing])
    expect(JSON.stringify(fromSales)).toBe(JSON.stringify(fromBilling))
  })
})

describe("resolving what the model asked for", () => {
  const skills = [sales, billing, retired]

  it("moves the conversation to the named colleague", () => {
    const resolved = resolveHandoff({
      call: { id: "t1", name: "handoff", input: { to: "Billing", reason: "asked for a refund" } },
      skills,
      current: sales,
    })
    expect(resolved?.target.id).toBe("s2")
    expect(resolved?.reason).toBe("asked for a refund")
  })

  it("ignores a target that is unknown, disabled, or itself", () => {
    const cases = ["Accounting", "Retired", "Sales"]
    for (const to of cases) {
      expect(
        resolveHandoff({ call: { id: "t", name: "handoff", input: { to } }, skills, current: sales }),
        to,
      ).toBeNull()
    }
  })

  it("ignores a call to a tool we do not define", () => {
    // Some models will happily invent one. Acting on it would run code nobody wrote.
    expect(
      resolveHandoff({
        call: { id: "t", name: "delete_everything", input: { to: "Billing" } },
        skills,
        current: sales,
      }),
    ).toBeNull()
  })

  it("still moves when the reason is missing, and records that it was", () => {
    // The reason is for the owner's report, not for routing. Refusing to move without one would
    // fail a customer to protect a log line.
    const resolved = resolveHandoff({
      call: { id: "t", name: "handoff", input: { to: "Billing" } },
      skills,
      current: sales,
    })
    expect(resolved?.target.id).toBe("s2")
    expect(resolved?.reason).toBe("not stated")
  })
})

describe("the cycle check", () => {
  it("catches a pair passing one question back and forth", () => {
    // Both are within their own per-turn limit — each has moved once. Only the turn's trail sees
    // that it is the same question going in circles.
    const trail = [{ from: "s1", to: "s2" }]
    expect(pairAlreadyUsed(trail, "s2", "s1")).toBe(true)
    expect(pairAlreadyUsed(trail, "s1", "s2")).toBe(true)
  })

  it("allows a question to keep moving forward through different skills", () => {
    const trail = [{ from: "s1", to: "s2" }]
    expect(pairAlreadyUsed(trail, "s2", "s3")).toBe(false)
  })
})
