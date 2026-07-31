import type { Settings } from "../lib/api"

/**
 * The settings a person can actually change.
 *
 * The dialog used to save by spreading the whole row it had fetched, which includes `tenant_id` —
 * a column the API deliberately refuses, because rejecting unknown fields is what catches a typo
 * before it silently does nothing. The result was that **every save returned 400**: models,
 * refusal text, budget, retention, high-risk topics, allowed origins, handoff limits, answer mode
 * and the whole widget theme were unreachable from the panel, which is where this product's
 * configuration is supposed to live.
 *
 * Listing the editable keys rather than subtracting the read-only ones is deliberate: a column
 * added to the GET response later cannot break saving again, because it will simply not be sent.
 */
export const EDITABLE_SETTINGS = [
  "answer_mode",
  "chat_model",
  "rewrite_model",
  "embedding_model",
  "refusal_text",
  "escalation_mode",
  "escalation_target",
  "monthly_budget_cents",
  "retention_days",
  "high_risk_topics",
  "allowed_origins",
  "widget_theme",
  "max_handoffs_per_turn",
  "max_handoffs_per_conversation",
] as const satisfies readonly (keyof Settings)[]

/** Keeps only what the API accepts, so a read-only column cannot make the save fail. */
export function settingsPayload(
  draft: Settings,
  widgetTheme: Record<string, unknown>,
): Partial<Settings> {
  const payload: Record<string, unknown> = {}
  for (const key of EDITABLE_SETTINGS) {
    if (key in draft) payload[key] = draft[key]
  }
  payload.widget_theme = widgetTheme
  return payload as Partial<Settings>
}
