import type { IncomingMessage, ServerResponse } from "node:http"
import { withTenant } from "@quidchat/db"
import { sql } from "drizzle-orm"
import {
  decryptSecrets,
  encryptSecrets,
  hasSecretKey,
  readSecretKey,
  type SecretDecryptError,
  type SecretKeyError,
} from "../secrets.js"
import { readJsonBody, resolveTenantOr404, rowsOf, sendJson, type AdminDeps } from "./shared.js"

// Part of the admin API. The router and the shared helpers live in `../admin.ts`.

/**
 * Which credentials each channel needs.
 *
 * Declared here rather than inferred, so the API can reject a half-configured channel. A
 * Telegram row without a bot token is a row that looks connected in the panel and silently
 * fails on the first customer message.
 */
export const CHANNEL_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  telegram: { required: ["botToken"], optional: ["secretToken"] },
  whatsapp: { required: ["phoneNumberId", "accessToken"], optional: ["appSecret"] },
  waha: { required: ["baseUrl"], optional: ["session", "apiKey"] },
  discord: { required: ["botToken"], optional: ["publicKey"] },
}

/**
 * `GET /admin/channels` — which channels this tenant has configured.
 *
 * NEVER returns a credential, not even masked. There is no use for the value in the panel: a
 * business either replaces it or leaves it alone, and a field that shows the first four
 * characters of a bot token is a field that leaks the first four characters of a bot token to
 * anything that reads the response. What comes back is which fields are set, which is all the
 * panel needs to render "connected" versus "not connected".
 */
export async function listChannels(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        SELECT channel, enabled, secrets, updated_at FROM channel_configs ORDER BY channel
      `),
    ),
  )

  let key: Buffer | null = null
  try {
    key = readSecretKey(deps.env ?? {})
  } catch {
    // Reported per row below rather than as a whole-request failure: the list is still worth
    // showing, and "the key is missing" is exactly what the panel needs to say.
  }

  sendJson(res, 200, {
    // The panel needs to know whether saving is even possible before it offers a form.
    secretKeyConfigured: hasSecretKey(deps.env ?? {}),
    fields: CHANNEL_FIELDS,
    channels: rows.map((r) => {
      const channel = r.channel as string
      let configuredFields: string[] = []
      let error: string | null = null
      if (key === null) {
        error = "QUIDCHAT_SECRET_KEY is not set, so these credentials cannot be read"
      } else {
        try {
          const secrets = decryptSecrets(r.secrets as string, key, `${channel} credentials`)
          configuredFields = Object.entries(secrets as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string" && v !== "")
            .map(([k]) => k)
        } catch (e) {
          error = (e as SecretDecryptError).message
        }
      }
      return {
        channel,
        enabled: r.enabled,
        updatedAt: r.updated_at,
        configuredFields,
        error,
      }
    }),
  })
}

/**
 * `PUT /admin/channels` — save one channel's credentials.
 *
 * Whole-row replacement rather than a partial update. A partial update means a business that
 * rotates a token cannot tell whether the old value is still there underneath, and this is a
 * table where "what is actually stored" has to be unambiguous.
 */
export async function putChannel(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    channel: typeof raw.channel === "string" ? raw.channel : "",
    enabled: raw.enabled !== false,
    secrets: (typeof raw.secrets === "object" && raw.secrets !== null ? raw.secrets : {}) as Record<
      string,
      unknown
    >,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return

  const spec = CHANNEL_FIELDS[body.channel]
  if (!spec) {
    sendJson(res, 400, {
      error: `channel must be one of ${Object.keys(CHANNEL_FIELDS).join(", ")}`,
    })
    return
  }

  const cleaned: Record<string, string> = {}
  for (const field of [...spec.required, ...spec.optional]) {
    const value = body.secrets[field]
    if (typeof value === "string" && value.trim() !== "") cleaned[field] = value.trim()
  }
  const missing = spec.required.filter((field) => !(field in cleaned))
  if (missing.length > 0) {
    // Named, because "invalid request" would leave an owner guessing which box they left empty.
    sendJson(res, 400, { error: `${body.channel} needs ${missing.join(" and ")}` })
    return
  }

  let key: Buffer
  try {
    key = readSecretKey(deps.env ?? {})
  } catch (e) {
    // 503, not 400: nothing is wrong with the request, and the operator — not the business
    // owner — is the one who has to fix it. The message says exactly how.
    sendJson(res, 503, { error: (e as SecretKeyError).message })
    return
  }

  const stored = encryptSecrets(cleaned, key)
  await withTenant(deps.db, tenantId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO channel_configs (tenant_id, channel, enabled, secrets)
      VALUES (${tenantId}, ${body.channel}, ${body.enabled}, ${stored})
      ON CONFLICT (tenant_id, channel) DO UPDATE
        SET secrets = ${stored}, enabled = ${body.enabled}, updated_at = now()
    `)
  })
  // The saved fields, never their values — same reason as the list route.
  sendJson(res, 200, { channel: body.channel, enabled: body.enabled, configuredFields: Object.keys(cleaned) })
}

/** `DELETE /admin/channels` — disconnect a channel entirely. */
export async function deleteChannel(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    channel: typeof raw.channel === "string" ? raw.channel : "",
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.channel) {
    sendJson(res, 400, { error: "channel is required" })
    return
  }

  const deleted = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(
        sql`DELETE FROM channel_configs WHERE channel = ${body.channel} RETURNING channel`,
      ),
    )[0],
  )
  if (!deleted) {
    sendJson(res, 404, { error: "that channel is not configured" })
    return
  }
  sendJson(res, 200, { ok: true })
}
