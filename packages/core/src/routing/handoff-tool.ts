import type { ToolCall, ToolDefinition } from "../provider.js"
import type { Skill } from "./router.js"

/**
 * The `handoff` tool — the one place a model decides something rather than composing prose.
 *
 * Until now a question moved between skills only when retrieval came back empty. That catches the
 * clear case and misses the common one: the Sales skill *does* find documents about the product,
 * and the customer is asking about a refund. Retrieval is not empty, so nothing moves, and Sales
 * answers a billing question out of a sales brochure — or refuses. Recognising "this is not my
 * territory" is a judgement about meaning, which is what the model is for and what a keyword rule
 * cannot do.
 *
 * Two properties are deliberate:
 *
 * The target is an **enum built from the database**, so the model cannot hand off to a skill that
 * does not exist. A free-text target would eventually name a plausible-sounding skill nobody
 * configured, and the failure would arrive as a customer receiving nothing.
 *
 * The list is **identical for every skill in a tenant**. Tools render before the system prompt, so
 * a per-skill tool list moves the first cache breakpoint to position 0 and re-bills the entire
 * prefix on every turn. Which targets a skill may actually reach is enforced here in code, after
 * the call — not by varying the list the model sees.
 */

export const HANDOFF_TOOL_NAME = "handoff"

/**
 * Builds the tool, or null when there is nothing to hand off to.
 *
 * Null rather than an empty enum: a tool the model cannot legally use still costs tokens on every
 * request and still invites a call that can only be rejected.
 */
export function handoffTool(skills: Skill[]): ToolDefinition | null {
  const targets = skills.filter((s) => s.enabled)
  if (targets.length < 2) return null

  return {
    name: HANDOFF_TOOL_NAME,
    description:
      "Pass this conversation to a colleague who handles the subject the customer is asking " +
      "about. Call this when the question is outside what you handle — not when you simply " +
      "lack a document about it. Answer from your own material whenever you can.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          // From the database, so an invented target is not representable.
          enum: targets.map((s) => s.name),
          description: "The colleague who should take over.",
        },
        reason: {
          type: "string",
          description: "One sentence on why this is theirs, for the business owner to read later.",
        },
      },
      required: ["to", "reason"],
      additionalProperties: false,
    },
  }
}

export type HandoffRequest = {
  target: Skill
  reason: string
}

/**
 * Resolves a tool call to a skill this conversation may actually move to.
 *
 * Returns null for anything unusable — a different tool, an unknown or disabled target, or the
 * skill already answering. The caller carries on with the current skill rather than failing: a
 * garbled handoff should cost the customer nothing, and an answer from the wrong-ish skill beats
 * an error.
 */
export function resolveHandoff(args: {
  call: ToolCall
  skills: Skill[]
  current: Skill | null
}): HandoffRequest | null {
  if (args.call.name !== HANDOFF_TOOL_NAME) return null

  const to = args.call.input.to
  if (typeof to !== "string") return null

  const target = args.skills.find((s) => s.name === to && s.enabled)
  if (!target) return null
  // Handing off to yourself is a loop that retrieves the same candidates and asks again.
  if (args.current && target.id === args.current.id) return null

  const reason = args.call.input.reason
  return { target, reason: typeof reason === "string" && reason.trim() !== "" ? reason : "not stated" }
}

/**
 * Whether this pair has already been handed off between during this turn.
 *
 * Sales sends a question to Billing, Billing sends it straight back, and both are within their
 * per-turn limit because each has moved only once. The turn's own trail is the only thing that
 * sees the cycle.
 */
export function pairAlreadyUsed(trail: { from: string | null; to: string }[], from: string | null, to: string): boolean {
  return trail.some(
    (step) =>
      (step.from === from && step.to === to) || (step.from === to && step.to === (from ?? "")),
  )
}
