import { presets, type Preset } from "./presets.js"
import { fetchWithRetry } from "./http.js"

/**
 * What a service actually offers, asked of the service.
 *
 * The panel used to make an owner type a model name into a text box. A typo, or a name that was
 * right last year, produces `unknown_model` on every question a customer asks — and the message
 * comes back from the vendor, at answer time, to a shop owner who has no way to connect it to the
 * box they typed in. Model catalogues also move: any list shipped in this repository is wrong
 * eventually, and wrong quietly.
 *
 * So the list is not shipped. Both OpenAI-compatible services and Anthropic answer `GET /models`
 * with `{ data: [{ id }] }`, which is the one thing they all agree on, and asking has a second
 * use: a key that cannot list models cannot answer questions either, so this doubles as the
 * check that a pasted credential actually works.
 */

export class ModelListError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelListError"
  }
}

/** The preset a set of credentials selects for chat — the same rule `resolveProviders` uses. */
function chatPreset(env: Record<string, string | undefined>): Preset | null {
  const explicit = env.QUIDCHAT_CHAT_PROVIDER
  if (explicit) return presets.find((p) => p.id === explicit) ?? null
  return (
    presets.find((p) => {
      const key = env[p.apiKeyVar]
      if (key !== undefined && key !== "") return true
      // Local runners announce themselves with a base URL rather than a key.
      return p.baseUrlVar !== undefined && env[p.baseUrlVar] !== undefined && env[p.baseUrlVar] !== ""
    }) ?? null
  )
}

/**
 * Asks the configured service which models it has.
 *
 * Returns them sorted, because a list in whatever order a vendor happens to serve is a list an
 * owner has to read twice. Throws rather than returning an empty array on failure: "this key
 * cannot reach the service" and "this service has no models" are different answers, and a screen
 * that shows an empty dropdown for the first one sends someone hunting for the wrong problem.
 */
export async function listModels(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const preset = chatPreset(env)
  if (!preset) throw new ModelListError("no provider is configured")

  const baseUrl = (preset.baseUrlVar ? env[preset.baseUrlVar] : undefined) ?? preset.baseUrl
  const apiKey = env[preset.apiKeyVar] ?? ""

  const headers: Record<string, string> = { accept: "application/json" }
  if (preset.kind === "anthropic") {
    headers["x-api-key"] = apiKey
    headers["anthropic-version"] = "2023-06-01"
  } else if (apiKey !== "") {
    headers.authorization = `Bearer ${apiKey}`
  }

  let res: Response
  try {
    res = await fetchWithRetry(fetchImpl, `${baseUrl.replace(/\/$/, "")}/models`, { headers })
  } catch {
    throw new ModelListError(
      `could not reach ${preset.id} — check the address and that the service is running`,
    )
  }

  if (!res.ok) {
    // 401 is the common one and worth naming, because "the key is wrong" is a different fix from
    // "the service is down" and an owner cannot tell them apart from a status code.
    throw new ModelListError(
      res.status === 401 || res.status === 403
        ? `${preset.id} rejected that key`
        : `${preset.id} answered ${res.status} when asked for its models`,
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ModelListError(`${preset.id} did not answer with JSON`)
  }

  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) throw new ModelListError(`${preset.id} did not list any models`)

  const ids = data
    .map((entry) => (entry as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id !== "")

  return [...new Set(ids)].toSorted()
}
