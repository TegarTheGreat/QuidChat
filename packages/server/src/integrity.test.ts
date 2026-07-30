import { tenants, tenantSettings, type QuidDb } from "@quidchat/db"
import { freshPglite } from "@quidchat/db/testing"
import { beforeAll, describe, expect, it } from "vitest"
import { checkIntegrity, reportIntegrity } from "./integrity.js"

let db: QuidDb

beforeAll(async () => {
  db = await freshPglite()
})

describe("checkIntegrity", () => {
  it("says nothing about a healthy database", async () => {
    const [tenant] = await db.insert(tenants).values({ slug: "healthy", name: "Healthy" }).returning()
    await db.insert(tenantSettings).values({ tenantId: tenant!.id })
    expect(await checkIntegrity(db)).toEqual([])
  })

  it("never fails a start-up over its own failure", async () => {
    // A business whose database is inconsistent still wants their assistant answering customers
    // while they sort it out, and a server that refused to boot over a settings row would turn a
    // quiet problem into an outage.
    const lines: string[] = []
    const errors: string[] = []
    const broken = { execute: async () => { throw new Error("no such table") } } as unknown as QuidDb

    await expect(
      reportIntegrity({ db: broken, log: (l) => lines.push(l), logError: (m) => errors.push(m) }),
    ).resolves.toEqual([])
    expect(errors.join(" ")).toMatch(/integrity check/)
    expect(lines).toEqual([])
  })

  it("says what a healthy database means: nothing printed", async () => {
    const lines: string[] = []
    await reportIntegrity({ db, log: (l) => lines.push(l), logError: () => {} })
    // Silence on success. A start-up that congratulates itself trains an operator to skim past
    // the line that eventually matters.
    expect(lines).toEqual([])
  })
})
