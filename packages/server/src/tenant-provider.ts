import { withTenant, type QuidDb } from "@quidchat/db"
import type { Provider } from "@quidchat/core"
import { sql } from "drizzle-orm"
import { decryptSecrets, encryptSecrets, hasSecretKey, readSecretKey } from "./secrets.js"

/**
 * The provider a given tenant answers with.
 *
 * Credentials are stored under the same environment-variable names the presets already read —
 * `OPENAI_API_KEY`, `GROQ_API_KEY`, `OLLAMA_BASE_URL` — so a tenant's keys can be handed to
 * exactly the resolver that reads the process environment. Selection order, the model each preset
 * defaults to, and the pairing of a chat provider with a separate embedding one then have one
 * implementation rather than two that drift.
 *
 * The resolver is injected rather than imported, for the same reason `provider` itself is: this
 * package knows how to serve a request and deliberately not how to choose a model vendor. The CLI
 * owns that and passes it down.
 */

/** Turns an env-shaped credential map into a provider, or null when nothing usable is there. */
export type ProviderResolver = (
  env: Record<string, string | undefined>,
) => Provider | null

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export type StoredProviderConfig = {
  /** Env-shaped credential names to values, e.g. `{ OPENAI_API_KEY: "sk-…" }`. */
  secrets: Record<string, string>
  chatProvider: string | null
  embedProvider: string | null
}

export async function readProviderConfig(
  db: QuidDb,
  tenantId: string,
  env: Record<string, string | undefined>,
): Promise<StoredProviderConfig | null> {
  // Without the key the blob cannot be read at all. Answering on the deployment's provider is the
  // only safe reading — guessing would answer customers on credentials nobody could verify.
  if (!hasSecretKey(env)) return null

  const rows = await withTenant(db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT chat_provider, embed_provider, secrets FROM provider_configs`),
    ),
  )
  const row = rows[0]
  if (!row) return null

  let secrets: Record<string, string> = {}
  try {
    const decrypted = decryptSecrets(String(row.secrets), readSecretKey(env), "provider credentials")
    if (decrypted !== null && typeof decrypted === "object") {
      for (const [name, value] of Object.entries(decrypted as Record<string, unknown>)) {
        if (typeof value === "string" && value !== "") secrets[name] = value
      }
    }
  } catch {
    // A blob written under a different key, or a corrupted one. Same reading as above.
    return null
  }

  return {
    secrets,
    chatProvider: typeof row.chat_provider === "string" ? row.chat_provider : null,
    embedProvider: typeof row.embed_provider === "string" ? row.embed_provider : null,
  }
}

export async function writeProviderConfig(
  db: QuidDb,
  tenantId: string,
  config: StoredProviderConfig,
  env: Record<string, string | undefined>,
): Promise<void> {
  const blob = encryptSecrets(config.secrets, readSecretKey(env))
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO provider_configs (tenant_id, chat_provider, embed_provider, secrets)
      VALUES (${tenantId}, ${config.chatProvider}, ${config.embedProvider}, ${blob})
      ON CONFLICT (tenant_id) DO UPDATE
        SET chat_provider = EXCLUDED.chat_provider,
            embed_provider = EXCLUDED.embed_provider,
            secrets = EXCLUDED.secrets,
            updated_at = now()
    `)
  })
}

export async function deleteProviderConfig(db: QuidDb, tenantId: string): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`DELETE FROM provider_configs`)
  })
}

/**
 * Resolves the provider for one tenant, falling back to the one built at startup.
 *
 * A tenant with its own credentials uses ONLY those, never merged with the deployment's. Merging
 * looks helpful and is not: a shop that sets a Groq key while the operator's OpenAI key sits in
 * the environment would find the documented search order picks OpenAI, and be billed on an
 * account it did not choose for a model it did not pick.
 *
 * Built per request rather than cached. A provider is a small object closing over `fetch`, and a
 * cache would keep answering on a key the owner has just replaced — the one moment where being
 * stale is worst.
 */
export async function providerForTenant(args: {
  db: QuidDb
  tenantId: string
  env: Record<string, string | undefined>
  fallback: Provider
  resolve: ProviderResolver | undefined
}): Promise<Provider> {
  if (!args.resolve) return args.fallback

  const config = await readProviderConfig(args.db, args.tenantId, args.env)
  if (!config || Object.keys(config.secrets).length === 0) return args.fallback

  const env: Record<string, string | undefined> = { ...config.secrets }
  if (config.chatProvider) env.QUIDCHAT_CHAT_PROVIDER = config.chatProvider
  if (config.embedProvider) env.QUIDCHAT_EMBED_PROVIDER = config.embedProvider

  // Credentials that resolve to nothing — a key for a preset that also needs a base URL, say —
  // must not silently take a tenant offline that was working off the deployment's provider.
  return args.resolve(env) ?? args.fallback
}
