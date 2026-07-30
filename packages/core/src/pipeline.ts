import { validateGrounding } from "./grounding/validator.js"
import { buildPrompt } from "./prompt/builder.js"
import { ProviderError } from "./provider-error.js"
import type { Provider } from "./provider.js"
import type { Store } from "./store.js"
import type { EscalationReason, PipelineResult, TokenUsage } from "./types.js"

const MAX_ROUNDS = 2
const CANDIDATE_LIMIT = 8

/**
 * Maps a provider failure to an escalation reason. Not everything is `schema_invalid` —
 * see `ProviderErrorKind` for why the distinction matters.
 * An error that is NOT a `ProviderError` is treated as unavailable, not as a
 * schema violation: we don't know the cause, and accusing the model is worse than
 * admitting ignorance.
 */
function escalationReasonFor(e: unknown): EscalationReason {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case "schema":
        return "schema_invalid"
      case "rate_limit":
      case "unavailable":
      case "auth":
      case "unknown_model":
        return "provider_unavailable"
    }
  }
  return "provider_unavailable"
}

/**
 * Answers a single customer question, or refuses.
 *
 * **Failure contract — deliberate and asymmetric.**
 *
 * PROVIDER failures are caught and become a recorded refusal. Reason: a provider
 * outage is per-message, the store is still alive so the escalation is correctly
 * recorded, and "we lost N conversations because the provider was down" is exactly
 * the information a business owner wants to see.
 *
 * STORE failures are NOT caught — they propagate to the caller. Three reasons:
 *   1. The `EscalationReason` value is a BUSINESS SIGNAL that the tenant reviews to
 *      decide what content their knowledge base needs. An unreachable database is not
 *      that signal, and recording it would pollute the metric that decisions are based on.
 *   2. `recordEscalation` itself goes through the store. If the store is down, recording
 *      the escalation would fail too — swallowing the error would just turn one failure
 *      into two silent failures.
 *   3. The server layer still needs a catch-all for bugs and OOM anyway, so that's
 *      where this belongs, not here.
 *
 * What the server layer should do: catch, log to operational logs (not to
 * `escalations`), reply to the visitor with a polite message, and return 503.
 */
export async function answer(args: {
  store: Store
  provider: Provider
  tenantId: string
  conversationId: string
  history: { role: "user" | "assistant"; content: string }[]
  question: string
}): Promise<PipelineResult> {
  const { store, provider, tenantId, conversationId, history, question } = args
  const config = await store.getTenantConfig(tenantId)

  await store.recordUserTurn({ tenantId, conversationId, text: question })

  // Summed across every provider call this turn makes, so a refusal reports what it
  // actually cost. The ungrounded path generates twice before giving up; reporting only
  // on success would let the most expensive outcome accumulate no recorded spend.
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: null }
  const addUsage = (u: TokenUsage) => {
    usage.inputTokens += u.inputTokens
    usage.outputTokens += u.outputTokens
    // `null` means unreported. Only promote to a number once a provider actually
    // reports one, so "unreported" and "zero cached" stay distinguishable.
    if (u.cachedTokens !== null) usage.cachedTokens = (usage.cachedTokens ?? 0) + u.cachedTokens
  }

  const refuse = async (reason: EscalationReason): Promise<PipelineResult> => {
    await store.recordEscalation({ tenantId, conversationId, reason })
    // The refusal text is recorded in the transcript too. Without this, a tenant who
    // opens a conversation to find out why the bot escalated would just see a question
    // with no reply, and a widget replaying the history would lose half the conversation.
    await store.recordAnswer({
      tenantId, conversationId,
      segments: [{ kind: "general", text: config.refusalText }],
      citedChunkIds: [],
    })
    return { kind: "refused", text: config.refusalText, reason, usage }
  }

  let embedding: number[]
  try {
    embedding = await provider.embed({ model: config.embeddingModel, text: question })
  } catch (e) {
    return refuse(escalationReasonFor(e))
  }

  const candidates = await store.searchChunks({
    tenantId, query: question, embedding,
    embeddingModel: config.embeddingModel,
    limit: CANDIDATE_LIMIT,
  })

  // Without candidates, there's nothing to cite. Refusing here saves one LLM
  // call that's guaranteed to fail validation.
  if (candidates.length === 0) return refuse("no_source")

  let feedback: string | undefined
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prompt = buildPrompt({ config, history, candidates, question, ...(feedback ? { feedback } : {}) })

    let result
    try {
      result = await provider.complete({ model: config.chatModel, prompt })
    } catch (e) {
      return refuse(escalationReasonFor(e))
    }

    const verdict = validateGrounding({
      answer: result.answer,
      candidates,
      highRiskTopics: config.highRiskTopics,
    })

    addUsage(result.usage)

    if (verdict.ok) {
      await store.recordAnswer({
        tenantId, conversationId,
        segments: result.answer.segments,
        citedChunkIds: verdict.citedChunkIds,
      })
      // The candidate set is still in hand here, so each cited id can be paired with the
      // document it came from. `recordAnswer` keeps taking bare ids because
      // `message_citations` stores the chunk reference; the title is derivable from it.
      const titles = new Map(candidates.map((c) => [c.id, c.documentTitle]))
      return {
        kind: "answered",
        segments: result.answer.segments,
        citations: verdict.citedChunkIds.map((chunkId) => ({
          chunkId,
          // A cited id always came from the candidate set — the validator rejects any
          // that did not — so the fallback is unreachable and exists only to keep the
          // type honest without an assertion.
          documentTitle: titles.get(chunkId) ?? "",
        })),
        usage,
      }
    }

    // The rejection reason is carried into the next round. Without this, round 2 sends
    // an IDENTICAL prompt, and a temperature-0 model returns an identical answer —
    // paying twice for a guaranteed duplicate.
    feedback = `${verdict.violation} — ${verdict.detail}`
  }

  return refuse("ungrounded")
}
