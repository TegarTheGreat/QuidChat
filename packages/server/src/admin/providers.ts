import type { IncomingMessage, ServerResponse } from "node:http"
import { hasSecretKey } from "../secrets.js"
import {
  credentialsForTenant,
  deleteProviderConfig,
  readProviderConfig,
  writeProviderConfig,
} from "../tenant-provider.js"
import { readJsonBody, resolveTenantOr404, type AdminDeps } from "./shared.js"

/**
 * The AI provider a business answers with, set from the panel.
 *
 * This was the one step a business could not do for itself: an operator had to set an environment
 * variable and restart the process. It is also the step without which nothing works at all, and it
 * falls on exactly the person this product is for — someone who can paste an API key into a form
 * and cannot edit a service file.
 *
 * Values are never sent back. The response says which credentials are stored, the same way the
 * channels route does, because "is my key saved" is a question the panel must answer and "what is
 * my key" is not.
 */

/** A trimmed string, or null for anything else — an absent explicit choice. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

export async function getProviders(
  res: ServerResponse,
  deps: AdminDeps,
  searchParams: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, searchParams.get("tenantSlug"))
  if (tenantId === null) return

  const env = deps.env ?? process.env
  const config = await readProviderConfig(deps.db, tenantId, env)
  sendJson(res, 200, {
    // Without this the panel would offer a form whose every save fails, which reads as the form
    // being broken rather than as the deployment missing a key.
    secretKeyConfigured: hasSecretKey(env),
    configuredFields: config ? Object.keys(config.secrets).toSorted() : [],
    chatProvider: config?.chatProvider ?? null,
    embedProvider: config?.embedProvider ?? null,
  })
}

export async function putProviders(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (!body) return

  const raw = body.secrets
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    sendJson(res, 400, { error: "secrets must be an object" })
    return
  }

  const secrets: Record<string, string> = {}
  const removals: string[] = []
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // Credential names are environment-variable names, and they are read back into an env map.
    // Anything else is refused rather than stored: a name with punctuation in it could only ever
    // fail to match a preset, silently, long after it was typed.
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      sendJson(res, 400, { error: `not a credential name: ${name}` })
      return
    }
    if (typeof value !== "string") {
      sendJson(res, 400, { error: `${name} must be a string` })
      return
    }
    const trimmed = value.trim()
    // An empty value is how one credential is removed while the others stay. See the merge below.
    if (trimmed === "") {
      removals.push(name)
      continue
    }

    /*
     * A base URL is fetched by this server, from this server. `GET /models` goes to whatever
     * address is stored here, so the value decides where the process makes a request.
     *
     * Loopback and private addresses cannot be refused the way `fetch-url.ts` refuses them for
     * page ingestion: a local runner IS a loopback address, and pointing at Ollama on the same
     * machine is one of the reasons to use this product. What is refused is anything that is not
     * plain http or https, and any address carrying credentials — neither is a thing a model
     * endpoint needs, and both are how a URL field becomes a way to reach something else.
     *
     * The residual risk is stated rather than hidden: an admin can aim this at an internal
     * address. It is bounded by the admin token, and the response body never leaves the server —
     * only model ids do.
     */
    if (name.endsWith("_BASE_URL")) {
      let parsed: URL
      try {
        parsed = new URL(trimmed)
      } catch {
        sendJson(res, 400, { error: `${name} is not a URL` })
        return
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        sendJson(res, 400, { error: `${name} must be an http or https address` })
        return
      }
      if (parsed.username !== "" || parsed.password !== "") {
        sendJson(res, 400, { error: `${name} must not carry a username or password` })
        return
      }
    }
    secrets[name] = trimmed
  }

  // Shape first, database second: a malformed request should not cost a tenant lookup, and this
  // ordering is what lets the rules above be tested without one.
  const tenantId = await resolveTenantOr404(
    res,
    deps.db,
    typeof body.tenantSlug === "string" ? body.tenantSlug : null,
  )
  if (tenantId === null) return

  if (Object.keys(secrets).length === 0 && removals.length === 0) {
    // Saving nothing is how an owner goes back to the deployment's provider, and deleting the row
    // says that plainly — an empty blob would read as "configured, with nothing in it".
    await deleteProviderConfig(deps.db, tenantId)
    sendJson(res, 200, { configuredFields: [], chatProvider: null, embedProvider: null })
    return
  }

  /*
   * Merged with what is already stored, not written over it.
   *
   * The panel used to send every credential box at once, so replacing the blob was the same as
   * updating it. It sends one provider at a time now — which is what a shop actually does — and a
   * plain replace would have deleted the others silently. That is not hypothetical: Groq serves
   * no embedding model, so "Groq for answers, OpenAI for search" is an ordinary pairing, and
   * saving the second one would have taken the first one's key with it and left the assistant
   * unable to search at all.
   *
   * Since the panel can never read a stored credential back, this merge can only happen here.
   */
  const existing = await readProviderConfig(deps.db, tenantId, deps.env ?? process.env)
  const merged = { ...existing?.secrets, ...secrets }
  for (const name of removals) delete merged[name]

  if (Object.keys(merged).length === 0) {
    await deleteProviderConfig(deps.db, tenantId)
    sendJson(res, 200, { configuredFields: [], chatProvider: null, embedProvider: null })
    return
  }

  try {
    await writeProviderConfig(
      deps.db,
      tenantId,
      {
        secrets: merged,
        chatProvider: asString(body.chatProvider),
        embedProvider: asString(body.embedProvider),
      },
      deps.env ?? process.env,
    )
  } catch (e) {
    // The missing-key case, which is an operator problem with a one-line fix rather than a bug.
    sendJson(res, 503, { error: e instanceof Error ? e.message : "could not store credentials" })
    return
  }

  sendJson(res, 200, {
    configuredFields: Object.keys(merged).toSorted(),
    chatProvider: asString(body.chatProvider),
    embedProvider: asString(body.embedProvider),
  })
}

export async function deleteProviders(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (!body) return
  const tenantId = await resolveTenantOr404(
    res,
    deps.db,
    typeof body.tenantSlug === "string" ? body.tenantSlug : null,
  )
  if (tenantId === null) return

  await deleteProviderConfig(deps.db, tenantId)
  sendJson(res, 200, { ok: true })
}

/**
 * `GET /admin/providers/models` — what the configured service actually offers.
 *
 * The panel used to make an owner type a model name. A typo produces `unknown_model` on every
 * question a customer asks, reported by the vendor at answer time to someone with no way to
 * connect it back to the box they typed in. Asking the service is also the only list that cannot
 * go stale, and it doubles as the check that a pasted key works at all.
 */
export async function getProviderModels(
  res: ServerResponse,
  deps: AdminDeps,
  searchParams: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, searchParams.get("tenantSlug"))
  if (tenantId === null) return

  if (!deps.listModels) {
    sendJson(res, 200, { models: [], error: "this server cannot list models" })
    return
  }
  const env = await credentialsForTenant({ db: deps.db, tenantId, env: deps.env ?? process.env })
  try {
    sendJson(res, 200, { models: await deps.listModels(env), error: null })
  } catch (e) {
    // 200 with an error string, not a 5xx: the panel shows a free-text box and the reason, which
    // is a screen someone can still finish. A failed request would just look broken.
    sendJson(res, 200, { models: [], error: e instanceof Error ? e.message : "could not list models" })
  }
}
