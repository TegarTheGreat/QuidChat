import { answer, type PipelineResult, type Provider, type Store } from "@quidchat/core"
import type { QuidDb } from "@quidchat/db"
import { monthlyBudgetCents, recordUsage, spentThisMonthCents } from "./budget.js"
import { notifyEscalationInBackground } from "./escalation-notify.js"
import { providerForTenant, type ProviderResolver } from "./tenant-provider.js"

/**
 * One customer turn, with everything that must happen around the pipeline.
 *
 * This exists because it did not, and the cost was real. The web widget checked the tenant's
 * monthly budget before answering and recorded what the answer cost afterwards. The channel
 * path — WhatsApp, Telegram, Discord, Slack, LINE, WAHA — called `answer()` directly and did
 * neither. So a business that set a spending cap had it enforced on its website and ignored on
 * the six places most of its customers actually are, and the spend those channels ran up was
 * never written down, which meant even the website's cap was measured against a number missing
 * most of the real total.
 *
 * The mistake was not the omission; it was that the guard lived at each entry point, so every
 * new one had to remember it. It lives here now, and a seventh channel gets it by calling this
 * instead of `answer()`.
 */
export async function answerTurn(args: {
  db: QuidDb
  store: Store
  provider: Provider
  tenantId: string
  conversationId: string
  history: { role: "user" | "assistant"; content: string }[]
  question: string
  /** `web`, or the channel id. Carried into the escalation notice so a business can tell a
   *  WhatsApp customer waiting on them from a website visitor. */
  channel: string
  logError: (message: string, cause: unknown) => void
  /** The process environment, for reading this tenant's own provider credentials. */
  env?: Record<string, string | undefined>
  /** Builds a provider from credentials. Absent means "always use the one built at startup". */
  resolveProvider?: ProviderResolver

  onProgress?: (stage: "retrieving" | "generating" | "validating") => void
}): Promise<PipelineResult> {
  const { db, store, provider, tenantId, conversationId, question, channel, logError } = args

  // `monthlyBudgetCents === 0` means unlimited — see budget.ts — so the spend query only runs
  // when there is a real limit to compare against, and the provider is never touched when the
  // tenant is already over it.
  const budget = await monthlyBudgetCents(db, tenantId)
  if (budget > 0 && (await spentThisMonthCents(db, tenantId)) >= budget) {
    const config = await store.getTenantConfig(tenantId)
    // Recorded the way `answer()` records any other refusal, so an owner reviewing the
    // transcript sees the question that went unanswered rather than a silent gap.
    await store.recordUserTurn({ tenantId, conversationId, text: question })
    await store.recordEscalation({ tenantId, conversationId, reason: "budget_exhausted" })
    await store.recordAnswer({
      tenantId,
      conversationId,
      segments: [{ kind: "general", text: config.refusalText }],
      citedChunkIds: [],
    })
    notifyEscalationInBackground({
      db,
      notice: { tenantId, conversationId, question, reason: "budget_exhausted", channel },
      logError,
    })
    return {
      kind: "refused",
      text: config.refusalText,
      reason: "budget_exhausted",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: null },
    }
  }

  // The tenant's own key when it has one, the deployment's otherwise. Resolved here rather than
  // at each entry point, so the widget and all six channels get the same answer to "whose account
  // is this billed to".
  const tenantProvider = await providerForTenant({
    db,
    tenantId,
    env: args.env ?? process.env,
    fallback: provider,
    resolve: args.resolveProvider,
  })

  const result = await answer({
    store,
    provider: tenantProvider,
    tenantId,
    conversationId,
    history: args.history,
    question,
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
  })

  // Recorded for refusals as well as answers, using the provider's own token counts rather than
  // an estimate. The `ungrounded` path generates twice and shows the visitor nothing, so billing
  // only successes would leave the most expensive outcome unbilled and unbounded by any budget.
  //
  // Skipped only when nothing was generated at all — an empty knowledge base refuses before the
  // first completion, and a zero-cost row is noise in a tenant's usage history.
  if (result.usage.inputTokens > 0 || result.usage.outputTokens > 0) {
    const config = await store.getTenantConfig(tenantId)
    await recordUsage(db, { tenantId, model: config.chatModel, usage: result.usage })
  }

  // A refusal IS the escalation signal — the assistant declining is exactly when a person needs
  // to take over — so the notice goes out here rather than from inside the pipeline, which stays
  // free of network and configuration concerns.
  if (result.kind === "refused") {
    notifyEscalationInBackground({
      db,
      notice: { tenantId, conversationId, question, reason: result.reason, channel },
      logError,
    })
  }

  return result
}
