import { describe, expect, it } from "vitest"
import { effectiveMode, type AnswerMode } from "./modes.js"

const MODES: AnswerMode[] = ["static", "thrifty", "full"]

describe("effectiveMode", () => {
  it("inherits the tenant's mode when the skill has no override, for all three modes", () => {
    for (const tenantMode of MODES) {
      expect(effectiveMode({ tenantMode, skillMode: null })).toBe(tenantMode)
    }
  })

  it("an explicit skill mode always overrides the tenant's, in every direction", () => {
    // Every (tenant, skill) pair, including where the skill picks a MORE expensive
    // mode than the tenant default and where it picks a CHEAPER one — both
    // directions must win, or one of the two motivating bugs slips through:
    // a cost-conscious tenant billed unexpectedly, or a nuance-needing skill
    // locked into canned text.
    for (const tenantMode of MODES) {
      for (const skillMode of MODES) {
        expect(effectiveMode({ tenantMode, skillMode })).toBe(skillMode)
      }
    }
  })
})
