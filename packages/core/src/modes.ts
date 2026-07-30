export type AnswerMode = "static" | "thrifty" | "full"

/**
 * Resolves the mode a skill actually answers in.
 *
 * `skillMode: null` means the skill carries no override and inherits the
 * tenant's default — the same pattern `escalation_mode` already uses, so
 * there's no second concept to learn. An explicit `skillMode` always wins,
 * even when it's less restrictive than the tenant's default.
 *
 * Getting the direction backwards is a real cost bug, not a cosmetic one: a
 * tenant on `static` whose skill quietly falls back to `full` starts paying
 * per token with no visible change in configuration, and a skill that was
 * deliberately given `full` for nuance gets flattened into canned text it
 * never asked for.
 */
export function effectiveMode(args: { tenantMode: AnswerMode; skillMode: AnswerMode | null }): AnswerMode {
  return args.skillMode ?? args.tenantMode
}
