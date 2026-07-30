import type { Capabilities, CompleteResult, Provider } from "@quidchat/core"
import { describe, expect, it } from "vitest"
import { composite } from "./composite.js"

/** A fake provider that just records which of its methods got called. */
function fakeProvider(id: string) {
  const calls: string[] = []
  const provider: Provider = {
    id,
    complete: (): Promise<CompleteResult> => {
      calls.push("complete")
      return Promise.resolve({
        answer: { segments: [{ text: "x", kind: "general" }] },
        toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: null },
      })
    },
    generateText: (): Promise<string> => {
      calls.push("generateText")
      return Promise.resolve("x")
    },
    embed: (): Promise<number[]> => {
      calls.push("embed")
      return Promise.resolve([0.1])
    },
    capabilities: (): Promise<Capabilities> => {
      calls.push("capabilities")
      return Promise.resolve({
        contextWindow: 1,
        maxOutput: 1,
        tools: false,
        vision: false,
        thinking: false,
        promptCaching: false,
      })
    },
  }
  return { provider, calls }
}

const prompt = { system: "s", history: [], currentTurn: "t" }

describe("composite", () => {
  it("names both halves in its id", () => {
    const chat = fakeProvider("anthropic")
    const embed = fakeProvider("openai")
    const p = composite({ chat: chat.provider, embed: embed.provider })
    expect(p.id).toBe("anthropic+openai")
  })

  it("routes complete only to the chat adapter", async () => {
    const chat = fakeProvider("anthropic")
    const embed = fakeProvider("openai")
    const p = composite({ chat: chat.provider, embed: embed.provider })
    await p.complete({ model: "m", prompt })
    expect(chat.calls).toEqual(["complete"])
    expect(embed.calls).toEqual([])
  })

  it("routes generateText only to the chat adapter", async () => {
    const chat = fakeProvider("anthropic")
    const embed = fakeProvider("openai")
    const p = composite({ chat: chat.provider, embed: embed.provider })
    await p.generateText({ model: "m", system: "s", user: "u" })
    expect(chat.calls).toEqual(["generateText"])
    expect(embed.calls).toEqual([])
  })

  it("routes embed only to the embed adapter", async () => {
    const chat = fakeProvider("anthropic")
    const embed = fakeProvider("openai")
    const p = composite({ chat: chat.provider, embed: embed.provider })
    await p.embed({ model: "m", text: "t" })
    expect(chat.calls).toEqual([])
    expect(embed.calls).toEqual(["embed"])
  })

  it("routes capabilities to the chat adapter", async () => {
    const chat = fakeProvider("anthropic")
    const embed = fakeProvider("openai")
    const p = composite({ chat: chat.provider, embed: embed.provider })
    await p.capabilities("m")
    expect(chat.calls).toEqual(["capabilities"])
    expect(embed.calls).toEqual([])
  })
})
