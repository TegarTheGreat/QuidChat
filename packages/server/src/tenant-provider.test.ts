import { beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { freshPglite } from "@quidchat/db/testing"
import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import type { Provider } from "@quidchat/core"
import { providerForTenant, readProviderConfig, writeProviderConfig } from "./tenant-provider.js"

const ENV = { QUIDCHAT_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") }

function namedProvider(id: string): Provider {
  return { id } as unknown as Provider
}

/**
 * Stands in for the CLI's real resolver, and mirrors its precedence: OpenAI is ahead of Groq in
 * the documented search order. That ordering is the whole reason the merge below would be wrong,
 * so a stand-in that checked Groq first would let the bug through.
 */
const resolve = (env: Record<string, string | undefined>): Provider | null => {
  const explicit = env.QUIDCHAT_CHAT_PROVIDER
  if (explicit === "groq" && env.GROQ_API_KEY) return namedProvider("groq:groq")
  if (env.OPENAI_API_KEY) return namedProvider("openai")
  if (env.GROQ_API_KEY) return namedProvider("groq:auto")
  return null
}

describe("whose account a tenant is billed to", () => {
  let db: QuidDb
  let shopId: string
  let plainId: string
  const deployment = namedProvider("deployment")

  beforeAll(async () => {
    db = await freshPglite()
    const [shop] = await db.insert(tenants).values({ slug: "shop", name: "Shop" }).returning()
    const [plain] = await db.insert(tenants).values({ slug: "plain", name: "Plain" }).returning()
    shopId = shop!.id
    plainId = plain!.id
    await db.insert(tenantSettings).values([{ tenantId: shopId }, { tenantId: plainId }])
  })

  it("uses the deployment's provider when a tenant has set none", async () => {
    const chosen = await providerForTenant({
      db, tenantId: plainId, env: ENV, fallback: deployment, resolve,
    })
    expect(chosen.id).toBe("deployment")
  })

  it("uses the tenant's own key once it has one", async () => {
    // The whole point: a business that pastes its key into the panel is billed on its own
    // account, without an operator editing the environment and restarting anything.
    await writeProviderConfig(
      db, shopId,
      { secrets: { GROQ_API_KEY: "gsk-shop" }, chatProvider: null, embedProvider: null },
      ENV,
    )
    const chosen = await providerForTenant({
      db, tenantId: shopId, env: ENV, fallback: deployment, resolve,
    })
    expect(chosen.id).toBe("groq:auto")
  })

  it("does not mix the deployment's credentials into a tenant's own", async () => {
    // Merging looks helpful and is not. With the operator's OpenAI key also present, the
    // documented search order would pick OpenAI — billing a shop on an account it never chose,
    // for a model it did not pick.
    const chosen = await providerForTenant({
      db,
      tenantId: shopId,
      env: { ...ENV, OPENAI_API_KEY: "sk-operator" },
      fallback: deployment,
      resolve,
    })
    expect(chosen.id).toBe("groq:auto")
  })

  it("carries an explicit choice through to the resolver", async () => {
    await writeProviderConfig(
      db, shopId,
      { secrets: { GROQ_API_KEY: "gsk-shop" }, chatProvider: "groq", embedProvider: "openai" },
      ENV,
    )
    const chosen = await providerForTenant({
      db, tenantId: shopId, env: ENV, fallback: deployment, resolve,
    })
    expect(chosen.id).toBe("groq:groq")
  })

  it("falls back rather than going offline when the credentials resolve to nothing", async () => {
    // A key for a preset that also needs a base URL, say. Taking a tenant offline that was
    // working a moment ago is the worse failure.
    await writeProviderConfig(
      db, shopId,
      { secrets: { SOMETHING_UNRECOGNISED: "x" }, chatProvider: null, embedProvider: null },
      ENV,
    )
    const chosen = await providerForTenant({
      db, tenantId: shopId, env: ENV, fallback: deployment, resolve,
    })
    expect(chosen.id).toBe("deployment")
  })

  it("keeps one tenant's credentials invisible to another", async () => {
    await writeProviderConfig(
      db, shopId,
      { secrets: { GROQ_API_KEY: "gsk-shop" }, chatProvider: null, embedProvider: null },
      ENV,
    )
    expect(await readProviderConfig(db, plainId, ENV)).toBeNull()
    const raw = await db.execute(sql`SELECT count(*)::int AS n FROM provider_configs`)
    const rows = (Array.isArray(raw) ? raw : (raw as unknown as { rows: { n: number }[] }).rows) as { n: number }[]
    expect(rows[0]!.n).toBe(1)
  })

  it("answers on the deployment's provider when the secret key is missing", async () => {
    // Without it the blob cannot be read at all. Guessing would answer customers on credentials
    // nobody could verify.
    const chosen = await providerForTenant({
      db, tenantId: shopId, env: {}, fallback: deployment, resolve,
    })
    expect(chosen.id).toBe("deployment")
  })
})
