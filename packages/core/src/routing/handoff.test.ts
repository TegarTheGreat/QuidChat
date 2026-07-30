import { describe, expect, it } from "vitest"
import { canHandoff } from "./handoff.js"

describe("canHandoff", () => {
  it("allows a handoff while under both the per-turn and per-conversation limits", () => {
    expect(canHandoff({ turnCount: 0, conversationCount: 0, maxPerTurn: 2, maxPerConversation: 5 }))
      .toBe(true)
    expect(canHandoff({ turnCount: 1, conversationCount: 4, maxPerTurn: 2, maxPerConversation: 5 }))
      .toBe(true)
  })

  it("refuses once the per-turn limit is reached, escalating with reason handoff_limit upstream", () => {
    // Two skills bouncing back and forth: this is the ping-pong scenario from spec §5.4.
    // `turnCount` already equals `maxPerTurn`, so a THIRD handoff this turn must stop.
    expect(canHandoff({ turnCount: 2, conversationCount: 2, maxPerTurn: 2, maxPerConversation: 5 }))
      .toBe(false)
  })

  it("refuses once the per-conversation limit is reached, even with turn budget left", () => {
    expect(canHandoff({ turnCount: 0, conversationCount: 5, maxPerTurn: 2, maxPerConversation: 5 }))
      .toBe(false)
  })
})
