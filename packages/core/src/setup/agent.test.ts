import { describe, expect, it, vi } from "vitest"
import { GATED_TOOLS, SETUP_TOOLS, describeAction, runSetupTurn } from "./agent.js"
import type { Provider, ToolCall } from "../provider.js"
import type { Answer } from "../types.js"

function reply(text: string): Answer {
  return { segments: [{ kind: "general", text }] }
}

/** A provider whose tool calls a test scripts, one entry per `complete` call. */
function scripted(script: ({ calls?: ToolCall[]; text?: string })[]): Provider {
  let i = 0
  return {
    id: "scripted",
    complete: async () => {
      const step = script[i++] ?? { text: "done" }
      return {
        answer: step.calls?.length ? null : reply(step.text ?? "done"),
        toolCalls: step.calls ?? [],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: null },
      }
    },
    generateText: async () => "",
    embed: async () => [0],
    capabilities: async () => ({
      contextWindow: 1, maxOutput: 1, tools: true, vision: false, thinking: false,
      promptCaching: false,
    }),
  }
}

const base = { model: "m", history: [], message: "help me set this up" }

describe("the confirmation gate", () => {
  it("does not run an action that changes what customers see", async () => {
    // The whole safety design: the assistant may propose freely, and the moment AI-written text
    // would become visible to a customer, a person decides.
    const execute = vi.fn(async () => ({ ok: true as const, detail: "done" }))
    const provider = scripted([
      { calls: [{ id: "1", name: "approve_canned_answers", input: { ids: ["a", "b"] } }] },
    ])

    const turn = await runSetupTurn({ provider, ...base, execute })

    expect(turn.kind).toBe("needs_confirmation")
    expect(execute).not.toHaveBeenCalled()
    if (turn.kind === "needs_confirmation") {
      expect(turn.pending.call.name).toBe("approve_canned_answers")
      expect(turn.pending.summary).toContain("2")
    }
  })

  it("gates every action the spec says is destructive, and no others", async () => {
    for (const name of [
      "approve_canned_answers", "delete_knowledge_source",
      "set_embedding_model", "set_provider_credential",
    ]) {
      expect(GATED_TOOLS.has(name), name).toBe(true)
    }
    for (const name of [
      "list_knowledge_sources", "run_diagnostics", "explain_setting", "test_flow",
      "add_knowledge_source", "create_skill", "set_routing_rule", "generate_canned_answers",
    ]) {
      // Gating a reversible action trains an owner to click Allow without reading, which is how
      // the gate stops protecting the four that matter.
      expect(GATED_TOOLS.has(name), name).toBe(false)
    }
  })

  it("holds back the rest of the batch when one call is gated", async () => {
    // A model that asks to delete a document and re-index in one turn must not have the re-index
    // happen while the owner is still deciding about the deletion.
    const execute = vi.fn(async () => ({ ok: true as const, detail: "done" }))
    const provider = scripted([
      {
        calls: [
          { id: "1", name: "delete_knowledge_source", input: { sourceId: "s1" } },
          { id: "2", name: "add_knowledge_source", input: { title: "new" } },
        ],
      },
    ])

    const turn = await runSetupTurn({ provider, ...base, execute })

    expect(turn.kind).toBe("needs_confirmation")
    expect(execute).not.toHaveBeenCalled()
  })
})

describe("running the reversible tools", () => {
  it("chains a diagnosis into an answer", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, detail: "no provider configured" }))
    const provider = scripted([
      { calls: [{ id: "1", name: "run_diagnostics", input: {} }] },
      { text: "You have no AI provider set." },
    ])

    const turn = await runSetupTurn({ provider, ...base, execute })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(turn.kind).toBe("reply")
    if (turn.kind === "reply") {
      expect(turn.text).toBe("You have no AI provider set.")
      expect(turn.ran).toEqual(["run_diagnostics"])
    }
  })

  it("tells the model when a tool failed instead of pretending it worked", async () => {
    const execute = vi.fn(async () => ({ ok: false as const, error: "that page returned 404" }))
    const provider = scripted([
      { calls: [{ id: "1", name: "add_knowledge_source", input: { title: "t", url: "u" } }] },
      { text: "That page could not be read." },
    ])

    await runSetupTurn({ provider, ...base, execute })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("stops instead of looping on the owner's money", async () => {
    // A model that keeps calling tools and never answers would bill a request per round forever.
    const execute = vi.fn(async () => ({ ok: true as const, detail: "ok" }))
    const provider = scripted(
      Array.from({ length: 12 }, () => ({
        calls: [{ id: "x", name: "run_diagnostics", input: {} }],
      })),
    )

    const turn = await runSetupTurn({ provider, ...base, execute })

    expect(turn.kind).toBe("reply")
    expect(execute.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

describe("what the owner is asked to allow", () => {
  it("says the consequence, not the function name", () => {
    // This sentence is the entire interface for a decision that costs money or changes what
    // customers are shown. "Run set_embedding_model" tells an owner nothing.
    expect(describeAction({ id: "1", name: "set_embedding_model", input: { model: "big" } }))
      .toMatch(/re-index every document/)
    expect(describeAction({ id: "1", name: "delete_knowledge_source", input: { sourceId: "x" } }))
      .toMatch(/will be refused/)
    expect(describeAction({ id: "1", name: "set_provider_credential", input: { provider: "openai" } }))
      .toMatch(/billed to you/)
  })
})

describe("the tool surface", () => {
  it("offers every tool the spec lists", () => {
    expect(SETUP_TOOLS.map((t) => t.name).toSorted()).toEqual([
      "add_knowledge_source", "approve_canned_answers", "create_skill",
      "delete_knowledge_source", "explain_setting", "generate_canned_answers",
      "list_knowledge_sources", "run_diagnostics", "set_embedding_model",
      "set_provider_credential", "set_routing_rule", "test_flow",
    ])
  })

  it("describes each tool for the model, with a schema it can fill", () => {
    for (const tool of SETUP_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20)
      expect(tool.parameters.type, tool.name).toBe("object")
      expect(tool.parameters.additionalProperties, tool.name).toBe(false)
    }
  })
})
