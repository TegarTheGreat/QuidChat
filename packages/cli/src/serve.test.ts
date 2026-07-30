import { describe, expect, it } from "vitest"
import { serve } from "./serve.js"

/** A fetch-free environment that yields an OpenAI-compatible provider for both roles. */
const WORKING_ENV = { OPENAI_API_KEY: "test-key", PORT: "0" }

describe("serve", () => {
  it("refuses to start when no provider is configured, and names the variables it checked", async () => {
    // Starting anyway would defer the failure to the first visitor question, where the
    // symptom is an unhelpful refusal and the cause is three layers away.
    await expect(serve({ env: { PORT: "0" }, log: () => {} })).rejects.toThrow(
      /No usable AI provider found/,
    )

    const message = await serve({ env: { PORT: "0" }, log: () => {} }).catch(
      (e: unknown) => (e as Error).message,
    )
    // The message must be actionable: the variable names ARE the fix.
    expect(message).toContain("OPENAI_API_KEY")
    expect(message).toContain("ANTHROPIC_API_KEY")
  })

  it("explains the embeddings gap when only a chat-only provider is configured", async () => {
    // Anthropic has no embeddings endpoint. A bare "no provider found" here would be
    // actively misleading — a key IS set, and the operator would reasonably conclude
    // the key was wrong rather than that a second one is needed.
    const message = await serve({
      env: { ANTHROPIC_API_KEY: "test-key", PORT: "0" },
      log: () => {},
    }).catch((e: unknown) => (e as Error).message)

    expect(message).toContain("no embeddings endpoint")
    expect(message).toContain("OPENAI_API_KEY")
  })

  it("starts, applies migrations, and reports what it chose", async () => {
    const lines: string[] = []
    const running = await serve({
      env: { ...WORKING_ENV, QUIDCHAT_DATA_DIR: "memory" },
      log: (line) => lines.push(line),
    })

    try {
      expect(running.port).toBeGreaterThan(0)
      // An operator must be able to see which provider and which database are in use.
      // A start-up that hides those decisions is what turns zero configuration from
      // convenience into confusion.
      expect(lines.some((l) => l.startsWith("database:"))).toBe(true)
      expect(lines.some((l) => l === "migrations: applied")).toBe(true)
      expect(lines.some((l) => l.includes("chat via openai"))).toBe(true)
      expect(lines.some((l) => l.includes("listening on http://localhost:"))).toBe(true)
    } finally {
      await running.close()
    }
  })

  it("serves the chat endpoint once started", async () => {
    // Proves the CLI wires the real server rather than merely constructing one: an
    // unknown tenant must come back 404 from the actual route.
    const running = await serve({
      env: { ...WORKING_ENV, QUIDCHAT_DATA_DIR: "memory" },
      log: () => {},
    })

    try {
      const res = await fetch(`http://localhost:${running.port}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.com" },
        body: JSON.stringify({ tenantSlug: "nobody", message: "hello" }),
      })
      expect(res.status).toBe(404)
    } finally {
      await running.close()
    }
  })
})
