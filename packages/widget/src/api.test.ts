import { afterEach, describe, expect, it, vi } from "vitest"
import { sendMessage } from "./api.js"
import type { WidgetConfig } from "./config.js"

/** Token counts are irrelevant to these tests; the shape just has to be present. */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cachedTokens: null }

const cfg: WidgetConfig = { tenantSlug: "acme", apiBase: "https://api.example.test" }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init ?? {})),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("sendMessage", () => {
  it("posts to {apiBase}/v1/chat with the tenant slug and message", async () => {
    let capturedUrl = ""
    let capturedBody: unknown
    stubFetch((url, init) => {
      capturedUrl = url
      capturedBody = JSON.parse(init.body as string)
      return jsonResponse(200, { conversationId: "c1", kind: "answered", segments: [], citations: [], usage: ZERO_USAGE })
    })

    await sendMessage(cfg, { message: "How long is the warranty?" })

    expect(capturedUrl).toBe("https://api.example.test/v1/chat")
    expect(capturedBody).toEqual({ tenantSlug: "acme", message: "How long is the warranty?" })
  })

  it("includes conversationId in the request body when the caller provides one", async () => {
    let capturedBody: unknown
    stubFetch((_url, init) => {
      capturedBody = JSON.parse(init.body as string)
      return jsonResponse(200, { conversationId: "c1", kind: "answered", segments: [], citations: [], usage: ZERO_USAGE })
    })

    await sendMessage(cfg, { conversationId: "c1", message: "And after that?" })

    expect(capturedBody).toEqual({ tenantSlug: "acme", conversationId: "c1", message: "And after that?" })
  })

  it("omits conversationId from the request body when the caller does not provide one", async () => {
    let capturedBody: unknown
    stubFetch((_url, init) => {
      capturedBody = JSON.parse(init.body as string)
      return jsonResponse(200, { conversationId: "c1", kind: "answered", segments: [], citations: [], usage: ZERO_USAGE })
    })

    await sendMessage(cfg, { message: "Hi" })

    expect(capturedBody).not.toHaveProperty("conversationId")
  })

  it("returns an answered result with its segments, citations, and conversationId", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        conversationId: "c1",
        kind: "answered",
        segments: [
          { kind: "general", text: "Sure, happy to help." },
          { kind: "business_claim", text: "The warranty lasts 12 months.", citations: ["chunk-42"] },
        ],
        citations: [{ chunkId: "chunk-42", documentTitle: "Warranty Policy" }],
      usage: ZERO_USAGE,
      }),
    )

    const result = await sendMessage(cfg, { message: "How long is the warranty?" })

    expect(result).toEqual({
      conversationId: "c1",
      kind: "answered",
      segments: [
        { kind: "general", text: "Sure, happy to help." },
        { kind: "business_claim", text: "The warranty lasts 12 months.", citations: ["chunk-42"] },
      ],
      citations: [{ chunkId: "chunk-42", documentTitle: "Warranty Policy" }],
      usage: ZERO_USAGE,
    })
  })

  it("returns a refusal as a normal result rather than throwing", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        conversationId: "c1",
        kind: "refused",
        text: "I don't have information about that.",
        reason: "no_source",
      }),
    )

    const result = await sendMessage(cfg, { message: "Do you offer teleportation?" })

    expect(result).toEqual({
      conversationId: "c1",
      kind: "refused",
      text: "I don't have information about that.",
      reason: "no_source",
    })
  })

  it("turns a 403 into an error that names the allowlist as the cause, not 'forbidden'", async () => {
    stubFetch(() => jsonResponse(403, { error: "origin not allowed" }))

    await expect(sendMessage(cfg, { message: "Hi" })).rejects.toThrow(/not authorized|allowed origins/i)
  })

  it("turns a 404 into an error that names the tenant key as unknown", async () => {
    stubFetch(() => jsonResponse(404, { error: "unknown tenant" }))

    await expect(sendMessage(cfg, { message: "Hi" })).rejects.toThrow(/tenant/i)
  })

  it("turns a 503 into a neutral 'temporarily unavailable' error, never the server's own text", async () => {
    stubFetch(() => jsonResponse(503, { error: "connection pool exhausted at 10.0.4.2" }))

    const rejection = expect(sendMessage(cfg, { message: "Hi" })).rejects
    await rejection.toThrow(/temporarily unavailable/i)
    await rejection.not.toThrow(/connection pool/i)
  })

  it("turns a network failure into the same neutral 'temporarily unavailable' error", async () => {
    stubFetch(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")))

    await expect(sendMessage(cfg, { message: "Hi" })).rejects.toThrow(/temporarily unavailable/i)
  })
})
