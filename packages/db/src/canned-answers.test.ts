import { describe, expect, it } from "vitest"
import { createStore } from "./store.js"
import { cannedAnswers, tenants, tenantSettings } from "./schema.js"
import { freshPglite } from "./testing.js"

describe("createStore.matchCannedAnswer", () => {
  it("ignores a draft answer even on a perfect match, and matches an approved one", async () => {
    // Spec mandatory test #7, exercised against the REAL SQL filter — not just the
    // in-memory fake. A single bug in the `status = 'approved'` clause would break the
    // promise that no AI-authored text reaches a customer with no visible symptom, so
    // this has to prove the actual query, not a stand-in for it.
    const db = await freshPglite()
    const [t] = await db.insert(tenants).values({ slug: "cannedco", name: "cannedco" }).returning()
    await db.insert(tenantSettings).values({ tenantId: t!.id })
    await db.insert(cannedAnswers).values([
      {
        tenantId: t!.id,
        question: "Do you ship internationally?",
        answer: "Draft: yes, worldwide shipping.",
        status: "draft",
      },
      {
        tenantId: t!.id,
        question: "What are your opening hours?",
        answer: "We are open 9 to 5, Monday to Friday.",
        status: "approved",
      },
    ])

    const store = createStore(db)

    // A perfect textual match against a DRAFT must still come back null.
    const draftMatch = await store.matchCannedAnswer({
      tenantId: t!.id,
      question: "Do you ship internationally?",
    })
    expect(draftMatch).toBeNull()

    // The APPROVED row, matched on the same exact text, must be found.
    const approvedMatch = await store.matchCannedAnswer({
      tenantId: t!.id,
      question: "What are your opening hours?",
    })
    expect(approvedMatch).toEqual({
      id: expect.any(String),
      answer: "We are open 9 to 5, Monday to Friday.",
    })
  })

  it("returns null when nothing matches at all", async () => {
    const db = await freshPglite()
    const [t] = await db.insert(tenants).values({ slug: "emptyco", name: "emptyco" }).returning()
    await db.insert(tenantSettings).values({ tenantId: t!.id })

    const match = await createStore(db).matchCannedAnswer({
      tenantId: t!.id,
      question: "anything at all",
    })
    expect(match).toBeNull()
  })
})
