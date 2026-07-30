export * from "./server.js"
// Exported so an embedder wiring QuidChat into their own HTTP stack can reuse the same
// limits, and so `rateLimits` on `ServerDeps` is nameable from outside the package.
export { ChatRateLimiter, DEFAULT_TENANT_LIMIT, DEFAULT_VISITOR_LIMIT, RateLimiter } from "./rate-limit.js"
export type { RateLimitConfig, RateLimitDecision } from "./rate-limit.js"
export { pruneExpiredConversations, startRetentionSchedule } from "./retention.js"
export type { PruneResult } from "./retention.js"
export { notifyEscalation, notifyEscalationInBackground } from "./escalation-notify.js"
export type { EscalationNotice } from "./escalation-notify.js"
export { checkIntegrity, reportIntegrity } from "./integrity.js"
export type { IntegrityProblem } from "./integrity.js"
