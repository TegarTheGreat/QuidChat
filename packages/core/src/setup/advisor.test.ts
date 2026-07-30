import { describe, expect, it } from "vitest"
import { adviseSetup, isReadyToAnswer, type SetupSnapshot } from "./advisor.js"

/** A tenant that is fully set up and answering. Each test breaks one thing. */
const HEALTHY: SetupSnapshot = {
  allowedOrigins: ["https://shop.example"],
  sourceCount: 2,
  readySourceCount: 2,
  erroredSourceCount: 0,
  chunkCount: 40,
  approvedCannedAnswerCount: 3,
  draftCannedAnswerCount: 0,
  answerMode: "full",
  monthlyBudgetCents: 5000,
  spentThisMonthCents: 100,
  escalationsNoSource: 0,
  hasProvider: true,
  highRiskTopics: ["price", "warranty"],
  refusalText: "Sorry, I do not have that yet.",
}

const ids = (s: SetupSnapshot) => adviseSetup(s).map((f) => f.id)

describe("adviseSetup", () => {
  it("reports nothing blocking for a healthy tenant", () => {
    expect(isReadyToAnswer(adviseSetup(HEALTHY))).toBe(true)
  })

  it("blocks on an empty origin list, because the widget is refused everywhere", () => {
    const findings = adviseSetup({ ...HEALTHY, allowedOrigins: [] })
    expect(ids({ ...HEALTHY, allowedOrigins: [] })).toContain("no-allowed-origins")
    expect(isReadyToAnswer(findings)).toBe(false)
  })

  it("blocks on having no content in a mode that needs it", () => {
    const bare = { ...HEALTHY, sourceCount: 0, chunkCount: 0, readySourceCount: 0 }
    expect(ids(bare)).toContain("no-sources")
    expect(isReadyToAnswer(adviseSetup(bare))).toBe(false)
  })

  it("does not ask for documents in static mode, which answers from approved text", () => {
    // Static mode exists so a business can run with no AI at all. Telling them to add
    // documents would be advice for a mode they deliberately turned off.
    const staticTenant: SetupSnapshot = {
      ...HEALTHY,
      answerMode: "static",
      sourceCount: 0,
      chunkCount: 0,
      readySourceCount: 0,
      hasProvider: false,
    }
    expect(ids(staticTenant)).not.toContain("no-sources")
    expect(ids(staticTenant)).not.toContain("no-provider")
    expect(isReadyToAnswer(adviseSetup(staticTenant))).toBe(true)
  })

  it("tells a static tenant with only drafts why nothing is answering", () => {
    // Drafts are ignored on purpose, so "you have answers but none are used" is exactly
    // the thing an owner cannot work out for themselves.
    const drafts: SetupSnapshot = {
      ...HEALTHY,
      answerMode: "static",
      approvedCannedAnswerCount: 0,
      draftCannedAnswerCount: 4,
    }
    const finding = adviseSetup(drafts).find((f) => f.id === "static-mode-no-approved-answers")
    expect(finding?.severity).toBe("blocker")
    expect(finding?.why).toContain("4 drafts")
  })

  it("treats an exhausted budget as blocking, and a near-exhausted one as a warning", () => {
    expect(ids({ ...HEALTHY, spentThisMonthCents: 5000 })).toContain("budget-exhausted")
    expect(ids({ ...HEALTHY, spentThisMonthCents: 4200 })).toContain("budget-nearly-exhausted")
  })

  it("surfaces repeated no-source escalations as the signal for what to write next", () => {
    expect(ids({ ...HEALTHY, escalationsNoSource: 7 })).toContain("many-no-source-escalations")
  })

  it("puts blockers before warnings and suggestions", () => {
    // A first-time owner reads the top of the list and stops, so ordering is behaviour.
    const broken: SetupSnapshot = {
      ...HEALTHY,
      allowedOrigins: [],
      erroredSourceCount: 1,
      highRiskTopics: [],
    }
    const severities = adviseSetup(broken).map((f) => f.severity)
    expect(severities[0]).toBe("blocker")
    expect(severities.indexOf("warning")).toBeLessThan(severities.indexOf("suggestion"))
  })

  it("gives every finding a concrete fix", () => {
    // A finding without an action is just bad news, which is worse than silence.
    const broken: SetupSnapshot = {
      ...HEALTHY,
      allowedOrigins: [],
      sourceCount: 0,
      chunkCount: 0,
      readySourceCount: 0,
      hasProvider: false,
      erroredSourceCount: 2,
      monthlyBudgetCents: 0,
      escalationsNoSource: 9,
      highRiskTopics: [],
      refusalText: "  ",
    }
    for (const finding of adviseSetup(broken)) {
      expect(finding.fix.length).toBeGreaterThan(10)
      expect(finding.why.length).toBeGreaterThan(10)
    }
  })
})
