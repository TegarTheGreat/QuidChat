import type { IncomingMessage, ServerResponse } from "node:http"
import { hasSecretKey } from "../secrets.js"
import {
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

  const tenantId = await resolveTenantOr404(
    res,
    deps.db,
    typeof body.tenantSlug === "string" ? body.tenantSlug : null,
  )
  if (tenantId === null) return

  const raw = body.secrets
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    sendJson(res, 400, { error: "secrets must be an object" })
    return
  }

  const secrets: Record<string, string> = {}
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
    if (value.trim() !== "") secrets[name] = value.trim()
  }

  if (Object.keys(secrets).length === 0) {
    // Saving nothing is how an owner goes back to the deployment's provider, and deleting the row
    // says that plainly — an empty blob would read as "configured, with nothing in it".
    await deleteProviderConfig(deps.db, tenantId)
    sendJson(res, 200, { configuredFields: [], chatProvider: null, embedProvider: null })
    return
  }

  try {
    await writeProviderConfig(
      deps.db,
      tenantId,
      { secrets, chatProvider: asString(body.chatProvider), embedProvider: asString(body.embedProvider) },
      deps.env ?? process.env,
    )
  } catch (e) {
    // The missing-key case, which is an operator problem with a one-line fix rather than a bug.
    sendJson(res, 503, { error: e instanceof Error ? e.message : "could not store credentials" })
    return
  }

  sendJson(res, 200, {
    configuredFields: Object.keys(secrets).toSorted(),
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
