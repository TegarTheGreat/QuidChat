import { describe, expect, it } from "vitest"
import { answer } from "./pipeline.js"
import { DEFAULT_CONFIG, FakeProvider, MemoryStore } from "./testing/fakes.js"
import type { RoutingRule, Skill } from "./routing/router.js"
import type { Candidate } from "./types.js"

/**
 * Model-initiated handoff.
 *
 * The mechanical trigger — retrieval came back empty — only catches the obvious case. The common
 * one is worse: Sales *does* find documents, because the customer named a product, and the actual
 * question is about a refund. Nothing is empty, so nothing moves, and Sales answers a billing
 * question out of a brochure. Recognising "this is not mine" is a judgement about meaning.
 */

const skills: Skill[] = [
  // Sales is the tenant's default, which is what makes this the interesting case: the question
  // lands on Sales because nothing routed it elsewhere, not because it belongs there.
  { id: "s1", name: "Sales", enabled: true, isFallback: true, systemPrompt: "You sell." },
  { id: "s2", name: "Billing", enabled: true, isFallback: false, systemPrompt: "You bill." },
] as Skill[]

/** Every question starts at Sales, which is what makes this the interesting case: it lands there
 *  because nothing routed it elsewhere, not because it belongs there. */
const rules: RoutingRule[] = [
  { id: "r1", skillId: "s1", kind: "fallback", pattern: null, position: 1, enabled: true },
] as RoutingRule[]

const candidate: Candidate = {
  id: "chunk-1",
  content: "Refunds are issued within 14 days.",
  documentTitle: "Refund policy",
}

const ctx = {
  tenantId: "t1",
  conversationId: "c1",
  history: [],
  question: "I want my money back for the blender",
}

describe("a skill passing a question to a colleague", () => {
  it("moves the conversation and answers from the new skill's material", async () => {
    const store = new MemoryStore([candidate], DEFAULT_CONFIG, skills, rules)
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Refunds take 14 days.", citations: ["chunk-1"] }] },
    ])
    // First call: the model hands off. Second: the new skill answers.
    provider.toolCallQueue = [
      [{ id: "t1", name: "handoff", input: { to: "Billing", reason: "this is a refund" } }],
    ]

    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    // Two generations: the one that handed off, and the one that answered.
    expect(provider.calls).toHaveLength(2)
    // The persona actually changed — this is the whole point. Without it the handoff moved a
    // label and the customer still hears from Sales.
    expect(provider.calls[0]!.system).toContain("You sell.")
    expect(provider.calls[1]!.system).toContain("You bill.")
    // Recorded against the skill that answered, so the owner's report is true.
    expect(store.recordedAnswers.at(-1)!.skillId).toBe("s2")
  })

  it("sends the identical tool list before and after the handoff", async () => {
    // Tools render before the system prompt. A list that changed per skill would move the first
    // cache breakpoint to position 0 and re-bill the whole prefix on every handoff.
    const store = new MemoryStore([candidate], DEFAULT_CONFIG, skills, rules)
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Refunds take 14 days.", citations: ["chunk-1"] }] },
    ])
    provider.toolCallQueue = [[{ id: "t1", name: "handoff", input: { to: "Billing", reason: "x" } }]]

    await answer({ store, provider, ...ctx })

    expect(provider.toolsSeen).toHaveLength(2)
    // Assert the tool is actually there before asserting the two are alike — comparing two
    // absent lists passes happily and proves nothing, which is how this test first read.
    const [first, second] = provider.toolsSeen
    expect(first).toBeDefined()
    expect(first!.map((t) => t.name)).toEqual(["handoff"])
    expect((first![0]!.parameters.properties as { to: { enum: string[] } }).to.enum).toEqual([
      "Sales",
      "Billing",
    ])
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it("carries no tool at all when the tenant has one skill", async () => {
    const store = new MemoryStore([candidate], DEFAULT_CONFIG, [skills[0]!], rules)
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Refunds take 14 days.", citations: ["chunk-1"] }] },
    ])

    await answer({ store, provider, ...ctx })

    // A tool nobody can legally use still costs tokens on every request.
    expect(provider.toolsSeen[0]).toBeUndefined()
  })

  it("stops a pair passing the same question back and forth", async () => {
    // Sales → Billing → Sales. Each skill has moved once, so both are inside the per-turn limit;
    // only the turn's own trail sees the loop. Without the check this bills every round.
    const store = new MemoryStore([candidate], DEFAULT_CONFIG, skills, rules)
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "unreachable", citations: ["chunk-1"] }] },
    ])
    provider.toolCallQueue = [
      [{ id: "t1", name: "handoff", input: { to: "Billing", reason: "theirs" } }],
      [{ id: "t2", name: "handoff", input: { to: "Sales", reason: "no, theirs" } }],
    ]

    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("refused")
    if (res.kind === "refused") expect(res.reason).toBe("handoff_limit")
  })

  it("keeps answering when the model names a colleague who does not exist", async () => {
    // The enum should make this unrepresentable; a model that ignores it must not cost the
    // customer their answer.
    const store = new MemoryStore([candidate], DEFAULT_CONFIG, skills, rules)
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Refunds take 14 days.", citations: ["chunk-1"] }] },
    ])
    provider.toolCallQueue = [[{ id: "t1", name: "handoff", input: { to: "Accounting" } }]]

    const res = await answer({ store, provider, ...ctx })

    // One call, which produced no answer and no usable handoff — refused rather than pretending.
    expect(res.kind).toBe("refused")
    expect(provider.calls).toHaveLength(1)
  })

  it("survives a provider that has never heard of tool calls", async () => {
    // `Provider` is a public interface — a self-hosted deployment can supply its own, and one
    // written before this field existed returns no `toolCalls` at all. Reading `.map` off that
    // took down every turn with a TypeError the customer saw as a refusal. Found in the suite,
    // not in review, because the fake that exposed it was cast past the compiler.
    const store = new MemoryStore([candidate], DEFAULT_CONFIG, skills, rules)
    const older = {
      complete: async () => ({
        answer: { segments: [{ kind: "business_claim" as const, text: "14 days.", citations: ["chunk-1"] }] },
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null },
      }),
      embed: async () => Array.from({ length: 8 }, () => 0.1),
      generateText: async () => "",
    }

    const res = await answer({ store, provider: older as never, ...ctx })

    expect(res.kind).toBe("answered")
  })

  it("counts the tokens the handoff round cost", async () => {
    // The round that ended in a tool call still ran the model. Not counting it under-reports what
    // a tenant actually spent.
    const store = new MemoryStore([candidate], DEFAULT_CONFIG, skills, rules)
    const provider = new FakeProvider([
      { segments: [{ kind: "business_claim", text: "Refunds take 14 days.", citations: ["chunk-1"] }] },
    ])
    provider.toolCallQueue = [[{ id: "t1", name: "handoff", input: { to: "Billing", reason: "x" } }]]

    const res = await answer({ store, provider, ...ctx })

    expect(res.kind).toBe("answered")
    if (res.kind === "answered") expect(res.usage.inputTokens).toBe(20)
  })
})
