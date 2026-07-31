import { describe, expect, it } from "vitest"
import { EDITABLE_SETTINGS, settingsPayload } from "./settings-payload.js"
import type { Settings } from "../lib/api"

const fetched = {
  tenant_id: "t-1",
  chat_model: "gpt-4o-mini",
  rewrite_model: "gpt-4o-mini",
  embedding_model: "text-embedding-3-small",
  refusal_text: "Sorry.",
  escalation_mode: "collect_contact",
  escalation_target: null,
  monthly_budget_cents: 0,
  retention_days: 90,
  high_risk_topics: ["price"],
  allowed_origins: ["https://shop.example"],
  widget_theme: { primaryColor: "#000" },
  max_handoffs_per_turn: 2,
  max_handoffs_per_conversation: 5,
  answer_mode: "full",
} as unknown as Settings

describe("what the settings dialog sends", () => {
  it("never sends a read-only column", () => {
    // The dialog spread the whole fetched row, which carries `tenant_id`. The API refuses unknown
    // fields — deliberately, so a typo cannot silently do nothing — so EVERY save returned 400 and
    // nothing in that dialog could be changed at all.
    const payload = settingsPayload(fetched, { primaryColor: "#fff" })
    expect("tenant_id" in payload).toBe(false)
  })

  it("sends every setting a person can edit", () => {
    const payload = settingsPayload(fetched, { primaryColor: "#fff" })
    for (const key of EDITABLE_SETTINGS) {
      expect(key in payload, key).toBe(true)
    }
  })

  it("takes the widget theme from the caller, not from the stale draft", () => {
    const payload = settingsPayload(fetched, { primaryColor: "#fff", locale: "id" })
    expect(payload.widget_theme).toEqual({ primaryColor: "#fff", locale: "id" })
  })

  it("ignores a column added to the response later", () => {
    // A new read-only column in the GET response must not break saving a second time.
    const withNewColumn = { ...fetched, something_added_later: "x" } as unknown as Settings
    const payload = settingsPayload(withNewColumn, {})
    expect("something_added_later" in payload).toBe(false)
  })
})
