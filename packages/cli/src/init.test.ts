import { knowledgeSources, tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { addText } from "./add-text.js"
import { initTenant } from "./init.js"

/**
 * The two commands that write a business's first rows.
 *
 * Both have had defects that only showed up on a real database: allowed origins arrived as a
 * single flattened scalar rather than a `text[]`, and a page read from the web was recorded as
 * if someone had pasted it. Neither is visible from a type or a mock — the column has to exist
 * and the driver has to bind it.
 */

let db: QuidDb

beforeAll(async () => {
  db = await freshPglite()
})

describe("initTenant", () => {
  it("creates the tenant, its settings row, and its origins as a real array", async () => {
    const result = await initTenant({
      db,
      slug: "init-shop",
      name: "Init Shop",
      origins: ["https://shop.example", "https://www.shop.example"],
    })
    expect(result.created).toBe(true)

    const [settings] = await db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, result.tenantId))
    // Two entries, not one string containing a comma. Binding the array directly flattens it into
    // a scalar and the insert fails — which is why this goes through a Postgres array literal.
    expect(settings!.allowedOrigins).toEqual(["https://shop.example", "https://www.shop.example"])

    // Without a settings row the tenant cannot answer at all: every read of its configuration
    // would find nothing.
    expect(settings).toBeDefined()
  })

  it("survives an origin containing a quote", async () => {
    // An origin is typed by an operator, and a stray quote in a hand-built array literal would
    // otherwise end the string early and corrupt the row.
    const result = await initTenant({
      db,
      slug: "init-quotes",
      name: "Quotes",
      origins: ['https://od"d.example', "https://back\\slash.example"],
    })
    const [settings] = await db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, result.tenantId))
    expect(settings!.allowedOrigins).toEqual(['https://od"d.example', "https://back\\slash.example"])
  })

  it("updates the origins when run again rather than failing", async () => {
    const first = await initTenant({
      db, slug: "init-twice", name: "Twice", origins: ["https://one.example"],
    })
    const second = await initTenant({
      db, slug: "init-twice", name: "Twice", origins: ["https://two.example"],
    })

    // An operator adding a second domain should not have to know whether the tenant exists.
    expect(second.created).toBe(false)
    expect(second.tenantId).toBe(first.tenantId)

    const rows = await db.select().from(tenants).where(eq(tenants.slug, "init-twice"))
    expect(rows).toHaveLength(1)
    const [settings] = await db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, first.tenantId))
    expect(settings!.allowedOrigins).toEqual(["https://two.example"])
  })
})

/** A provider that embeds without a network, so the test exercises the real write path. */
function stubProvider() {
  return {
    embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
    complete: async () => ({
      answer: { segments: [] },
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: null },
    }),
    generateText: async () => "",
  }
}

describe("addText", () => {
  const env = { OPENAI_API_KEY: "sk-test" }

  it("records pasted text and a fetched page differently", async () => {
    const tenant = await initTenant({
      db, slug: "add-shop", name: "Add Shop", origins: ["https://add.example"],
    })
    vi.spyOn(await import("@quidchat/providers"), "resolveProviders").mockReturnValue({
      provider: stubProvider() as never,
      chosen: { chat: "test", embed: "test" },
      checked: [],
    } as never)

    await addText({
      db, env, slug: "add-shop", title: "Store Policy",
      text: "Returns are accepted within seven days.", log: () => {},
    })
    await addText({
      db, env, slug: "add-shop", title: "Delivery terms",
      text: "We deliver next day.", kind: "url", url: "https://add.example/delivery", log: () => {},
    })

    const sources = await db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenantId, tenant.tenantId))

    const pasted = sources.find((s) => s.uri === "Store Policy")
    const fetched = sources.find((s) => s.uri === "https://add.example/delivery")
    // Text pasted in and a page read from the web must not land in the database looking
    // identical: the kind is what the panel shows, and the URI is what a re-read would follow.
    expect(pasted?.kind).toBe("text")
    expect(fetched?.kind).toBe("url")
  })

  it("refuses empty text rather than reporting success on nothing", async () => {
    await initTenant({
      db, slug: "add-empty", name: "Empty", origins: ["https://e.example"],
    })
    // Indexing whitespace produces zero chunks and would report success, leaving an operator
    // believing content was added.
    await expect(
      addText({ db, env, slug: "add-empty", title: "Nothing", text: "   \n ", log: () => {} }),
    ).rejects.toThrow(/empty/)
  })

  it("names the tenant when the slug is unknown", async () => {
    await expect(
      addText({ db, env, slug: "no-such-shop", title: "x", text: "y", log: () => {} }),
    ).rejects.toThrow(/no-such-shop/)
  })
})
