import { validateGrounding } from "./grounding/validator.js"
import { effectiveMode, type AnswerMode } from "./modes.js"
import { canHandoff } from "./routing/handoff.js"
import { route, type Skill } from "./routing/router.js"
import { buildPrompt } from "./prompt/builder.js"
import { ProviderError } from "./provider-error.js"
import type { Provider } from "./provider.js"
import type { Store } from "./store.js"
import type { EscalationReason, PipelineResult, Segment, TokenUsage } from "./types.js"

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
  /**
   * Reports which stage the turn is in, so a caller can show progress.
   *
   * Optional and fire-and-forget: the pipeline never awaits it and never lets it fail the
   * turn. A progress callback that could throw would let a cosmetic concern break an
   * answer, which is the wrong trade in both directions.
   */
  onProgress?: (stage: "retrieving" | "generating" | "validating") => void
}): Promise<PipelineResult> {
  const { store, provider, tenantId, conversationId, history, question } = args
  const progress = (stage: "retrieving" | "generating" | "validating") => {
    try {
      args.onProgress?.(stage)
    } catch {
      // Swallowed on purpose — see the doc on `onProgress`. A broken listener must not
      // cost the customer their answer.
    }
  }
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

  // Answers a customer question from an approved canned answer, recording it exactly
  // like a generated answer: one `general` segment, no citations. `static` mode's
  // grounding guarantee comes from the human review at APPROVAL time (spec §6.1), not
  // from the runtime validator — so this deliberately never touches `validateGrounding`.
  const respondWithCanned = async (canned: { answer: string }): Promise<PipelineResult> => {
    const segments: Segment[] = [{ kind: "general", text: canned.answer }]
    await store.recordAnswer({ tenantId, conversationId, segments, citedChunkIds: [] })
    return { kind: "answered", segments, citations: [], usage }
  }

  // --- Routing -------------------------------------------------------------------
  //
  // The skill decides three things: which answer mode applies, which sources may be
  // retrieved from, and what system prompt is used. Routing therefore has to happen
  // BEFORE the mode branch below — a skill in static mode inside a tenant set to full
  // must still cost nothing, and that is only true if the skill is known first.
  //
  // A tenant with no skills configured routes to null and behaves exactly as before, so
  // this is additive: nobody has to define a skill to get an answer.
  const skills = await store.listSkills(tenantId)
  const rules = await store.listRoutingRules(tenantId)
  let skill: Skill | null = skills.length > 0 ? route({ rules, skills, message: question }) : null

  // Handoff: when the routed skill has nothing to answer from, responsibility passes to
  // the fallback skill — once, and only within the configured limits. Without a cap two
  // skills pointing at each other loop forever, billing every turn, which is why
  // `handoff_limit` exists as an escalation reason at all.
  const fallbackSkill = skills.find((s) => s.isFallback && s.enabled) ?? null
  let handoffsThisTurn = 0

  const sourceIdsFor = async (s: Skill | null): Promise<string[] | null> => {
    if (!s) return null
    const ids = await store.sourceIdsForSkill({ tenantId, skillId: s.id })
    // A skill with no sources linked would otherwise scope retrieval to nothing and
    // refuse every question — worse than the tenant-wide default, and silently so.
    return ids.length > 0 ? ids : null
  }

  const mode = effectiveMode({ tenantMode: config.answerMode, skillMode: (skill?.answerMode ?? null) as AnswerMode | null })

  // `static`: zero cost, by construction. The provider is not touched AT ALL — not
  // `embed`, not `complete` — because the entire point of this mode is that no runtime
  // AI call exists to fail, rate-limit, or bill. A miss escalates rather than falling
  // through to retrieval; `fallback_to_full` (per-skill) is out of scope here.
  if (mode === "static") {
    const canned = await store.matchCannedAnswer({ tenantId, question })
    return canned ? respondWithCanned(canned) : refuse("no_source")
  }

  progress("retrieving")

  let embedding: number[]
  try {
    embedding = await provider.embed({ model: config.embeddingModel, text: question })
  } catch (e) {
    return refuse(escalationReasonFor(e))
  }

  const retrieve = async (s: Skill | null) => {
    const sourceIds = await sourceIdsFor(s)
    return store.searchChunks({
      tenantId, query: question, embedding,
      embeddingModel: config.embeddingModel,
      limit: CANDIDATE_LIMIT,
      ...(sourceIds ? { sourceIds } : {}),
    })
  }

  let candidates = await retrieve(skill)

  // The routed skill found nothing in its own sources. Hand off to the fallback skill,
  // which is scoped differently and may well have the answer — this is the whole point of
  // letting skills pass responsibility to each other.
  if (candidates.length === 0 && skill && fallbackSkill && fallbackSkill.id !== skill.id) {
    const conversationHandoffs = await store.incrementHandoffCount({ tenantId, conversationId })
    if (
      canHandoff({
        turnCount: handoffsThisTurn,
        conversationCount: conversationHandoffs - 1,
        maxPerTurn: config.maxHandoffsPerTurn,
        maxPerConversation: config.maxHandoffsPerConversation,
      })
    ) {
      handoffsThisTurn += 1
      skill = fallbackSkill
      candidates = await retrieve(fallbackSkill)
    } else {
      // Two skills that keep passing a question between them would loop and bill every
      // turn. Stopping at the limit is what makes a configurable flow safe to configure.
      return refuse("handoff_limit")
    }
  }

  // Without candidates, there's nothing to cite. Refusing here saves one LLM
  // call that's guaranteed to fail validation.
  if (candidates.length === 0) return refuse("no_source")

  // `thrifty`: still no generation. The best retrieved chunk is quoted VERBATIM as a
  // `business_claim` citing itself — never composed by a model, so there is nothing to
  // hallucinate. `provider.complete` is never called in this branch.
  if (mode === "thrifty") {
    const top = candidates[0]!
    const segments: Segment[] = [
      { kind: "business_claim", text: top.content, citations: [top.id] },
    ]
    await store.recordAnswer({ tenantId, conversationId, segments, citedChunkIds: [top.id] })
    return {
      kind: "answered",
      segments,
      citations: [{ chunkId: top.id, documentTitle: top.documentTitle }],
      usage,
    }
  }

  let feedback: string | undefined
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // A skill's own instructions are appended to the grounding rules, never in place of
    // them — that is how one business gives Sales and Support different voices over the
    // same documents without either being able to switch citations off.
    const prompt = buildPrompt({
      config, history, candidates, question,
      ...(feedback ? { feedback } : {}),
      ...(skill?.systemPrompt ? { skillPrompt: skill.systemPrompt } : {}),
    })

    progress("generating")

    let result
    try {
      result = await provider.complete({ model: config.chatModel, prompt })
    } catch (e) {
      return refuse(escalationReasonFor(e))
    }

    progress("validating")

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
