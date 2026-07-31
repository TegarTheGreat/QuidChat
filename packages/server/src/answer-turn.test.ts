import { describe, expect, it, vi } from "vitest"
vi.mock("./budget.js", () => ({
  monthlyBudgetCents: async (db: { budget: number }) => db.budget,
  spentThisMonthCents: async (db: { spent: number }) => db.spent,
  recordUsage: async () => {},
}))
vi.mock("@quidchat/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  answer: async () => ({
    kind: "answered", segments: [{ kind: "general", text: "ok" }], citations: [],
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null },
  }),
}))
vi.mock("./escalation-notify.js", () => ({ notifyEscalationInBackground: () => {} }))

import { answerTurn } from "./answer-turn.js"

/**
 * The budget guard used to live at each entry point. The web widget had it; the six channel
 * adapters did not — they called `answer()` directly, so a business that set a spending cap had
 * it enforced on its website and ignored on WhatsApp, Telegram, Discord, Slack, LINE and WAHA.
 * The spend from those channels was never recorded either, so even the website's cap was
 * measured against a number missing most of the real total.
 */

/** The budget module is stubbed below, so these two numbers are the whole database. */
function depsWith(opts: { budgetCents: number; spentCents: number }) {
  const db = { budget: opts.budgetCents, spent: opts.spentCents }
  const store = {
    getTenantConfig: async () => ({ chatModel: "m", refusalText: "Maaf, saya belum bisa menjawab." }),
    recordUserTurn: vi.fn(async () => {}),
    recordEscalation: vi.fn(async () => {}),
    recordAnswer: vi.fn(async () => {}),
  }
  return { db, store }
}

const provider = { complete: vi.fn() }

describe("the budget guard, wherever the question came from", () => {
  it("refuses without touching the provider when a tenant is over its cap", async () => {
    const { db, store } = depsWith({ budgetCents: 1000, spentCents: 1000 })

    const result = await answerTurn({
      db: db as never, store: store as never, provider: provider as never,
      tenantId: "t1", conversationId: "c1", history: [],
      question: "berapa harga barang ini?",
      channel: "whatsapp",
      logError: () => {},
    })

    expect(result.kind).toBe("refused")
    if (result.kind === "refused") expect(result.reason).toBe("budget_exhausted")
    // The point of checking BEFORE the call: an exhausted tenant incurs no further cost.
    expect(provider.complete).not.toHaveBeenCalled()
    // And the unanswered question is still in the transcript, so an owner reviewing the
    // conversation sees it rather than a silent gap.
    expect(store.recordUserTurn).toHaveBeenCalled()
    expect(store.recordEscalation).toHaveBeenCalled()
  })

  it("treats a zero cap as unlimited rather than as nothing allowed", async () => {
    // `monthly_budget_cents = 0` is the default and means "no limit". Reading it as a limit of
    // zero would refuse every question for every tenant that never set one.
    const { db, store } = depsWith({ budgetCents: 0, spentCents: 5000 })

    const result = await answerTurn({
      db: db as never, store: store as never, provider: provider as never,
      tenantId: "t1", conversationId: "c1", history: [],
      question: "halo", channel: "telegram", logError: () => {},
    })

    expect(result.kind).not.toBe("refused")
  })
})
