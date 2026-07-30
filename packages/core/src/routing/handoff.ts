/**
 * Whether another handoff may happen this turn, given the counts so far.
 *
 * Two independent ceilings (spec §5.4), both must hold:
 *   - `maxPerTurn` stops handoff ping-pong within a single turn — when hit, the
 *     current skill answers instead of handing off again.
 *   - `maxPerConversation` is the harder ceiling — when hit, the caller escalates
 *     to a human with `reason: "handoff_limit"` instead of letting the conversation
 *     bounce indefinitely.
 *
 * Both counts are compared with strict `<`, not `<=`: `turnCount`/`conversationCount`
 * are the number of handoffs ALREADY made, so a limit of 2 permits handoffs while the
 * count is 0 or 1, and refuses once it reaches 2 — exactly two handoffs happened, not
 * three.
 */
export function canHandoff(args: {
  turnCount: number
  conversationCount: number
  maxPerTurn: number
  maxPerConversation: number
}): boolean {
  return args.turnCount < args.maxPerTurn && args.conversationCount < args.maxPerConversation
}
