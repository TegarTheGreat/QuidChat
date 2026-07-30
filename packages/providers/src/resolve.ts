import type { Provider } from "@quidchat/core"
// NOTE: `./anthropic.js` is being created by another agent in this same round.
// This import will not resolve until that file lands — that is expected, not a
// bug in this file. See the task report for the assumed signature.
import { anthropic } from "./anthropic.js"
import { composite } from "./composite.js"
import { openAiCompatible } from "./openai-compatible.js"
import { presets, type Preset } from "./presets.js"

export type ResolveResult = {
  /** A ready-to-use provider, or null when nothing usable could be assembled. */
  provider: Provider | null
  /** What was picked for chat and for embedding, so a caller can report it
   *  instead of silently depending on it. */
  chosen: { chat: string | null; embed: string | null }
  /** Every preset that was checked, and whether it was found present. This is
   *  what makes the "zero configuration" magic accountable: a caller can see
   *  WHY something was, or was not, picked. */
  trace: { preset: string; envVar: string; present: boolean }[]
}

/** Whether a preset's key (or, for local runners, its base-url override) is set in `env`. */
function isPresent(preset: Preset, env: Record<string, string | undefined>): boolean {
  if (preset.apiKeyOptional) {
    return Boolean(preset.baseUrlVar && env[preset.baseUrlVar])
  }
  return Boolean(env[preset.apiKeyVar])
}

/** The environment variable whose presence is the signal for this preset,
 *  reported in the trace so the caller can see exactly what was checked. */
function presenceVariable(preset: Preset): string {
  return preset.apiKeyOptional ? (preset.baseUrlVar ?? preset.apiKeyVar) : preset.apiKeyVar
}

/** Resolves the base URL to use, honoring an override variable when set and non-empty. */
function resolveBaseUrl(preset: Preset, env: Record<string, string | undefined>): string {
  const override = preset.baseUrlVar ? env[preset.baseUrlVar] : undefined
  return override && override.length > 0 ? override : preset.baseUrl
}

/** Constructs the actual adapter for a preset found present in `env`. */
function build(preset: Preset, env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Provider {
  const apiKey = env[preset.apiKeyVar] ?? ""
  if (preset.kind === "anthropic") {
    return anthropic({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) })
  }
  return openAiCompatible({
    id: preset.id,
    baseUrl: resolveBaseUrl(preset, env),
    apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}

/**
 * Scans `env` for recognized provider keys and assembles a ready provider,
 * reporting exactly what it found and picked.
 *
 * Deliberately takes `env` as an argument rather than reading `process.env`
 * itself: that keeps this function testable without mutating real process
 * state, and preserves the boundary that only the outermost layer of the app
 * touches the process.
 *
 * `fetchImpl`, when given, is threaded into whichever adapter gets built, so
 * callers (tests, in particular) never need the resolver to reach the network.
 */
export function resolveProviders(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): ResolveResult {
  const trace = presets.map((preset) => ({
    preset: preset.id,
    envVar: presenceVariable(preset),
    present: isPresent(preset, env),
  }))

  const chatPreset = presets.find((preset) => isPresent(preset, env)) ?? null
  // Among present presets, the first one that actually has an embeddings
  // endpoint wins for embed. A present-but-embeddings-less preset (Anthropic,
  // Groq, DeepSeek) never qualifies here, no matter how early it sits in the
  // search order.
  const embedPreset = presets.find((preset) => preset.hasEmbeddings && isPresent(preset, env)) ?? null

  const chosen = { chat: chatPreset?.id ?? null, embed: embedPreset?.id ?? null }

  // Refuse to hand back a provider that cannot embed. Doing otherwise would
  // push the failure downstream to the first retrieval call, far from its
  // actual cause (a missing key for anything with an embeddings endpoint).
  if (!chatPreset || !embedPreset) {
    return { provider: null, chosen, trace }
  }

  if (chatPreset.id === embedPreset.id) {
    return { provider: build(chatPreset, env, fetchImpl), chosen, trace }
  }

  const chat = build(chatPreset, env, fetchImpl)
  const embed = build(embedPreset, env, fetchImpl)
  return { provider: composite({ chat, embed }), chosen, trace }
}
