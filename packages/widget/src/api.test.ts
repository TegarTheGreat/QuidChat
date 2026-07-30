import { afterEach, describe, expect, it, vi } from "vitest"
import { sendMessage, sendMessageWithProgress } from "./api.js"
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

describe("rate limiting", () => {
  it("names the wait from Retry-After instead of reporting an outage", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "too many requests" }), {
        status: 429,
        headers: { "retry-after": "4" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      sendMessage(cfg, { message: "hi" }),
    ).rejects.toThrow("wait 4 seconds")
  })

  it("falls back to a stated wait when the header is missing or nonsense", async () => {
    for (const headers of [{}, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers })))
      // An HTTP-date is legal in Retry-After but Number() makes it NaN. A NaN in the copy
      // would read as "wait NaN seconds", so the fallback has to catch it as well as absence.
      await expect(
        sendMessage(cfg, { message: "hi" }),
      ).rejects.toThrow("wait 5 seconds")
    }
  })
})

/** A Response whose body streams the given SSE text in the given pieces, so a payload split
 *  mid-event is exercised rather than assumed to arrive whole. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("streaming progress", () => {
  const answered = {
    conversationId: "c1",
    kind: "answered",
    segments: [{ kind: "general", text: "Open daily." }],
    citations: [],
    usage: ZERO_USAGE,
  }

  it("reports each stage and returns the result, even when an event arrives split", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'event: progress\ndata: {"stage":"retrieving"}\n\n',
          'event: progress\ndata: {"stage":"generating"}\n\nevent: progress\ndata: {"stage":"vali',
          'dating"}\n\nevent: result\ndata: ' + JSON.stringify(answered) + "\n\n",
        ]),
      ),
    )

    const stages: string[] = []
    const result = await sendMessageWithProgress(cfg, { message: "hours?" }, (s) => stages.push(s))

    // A stage lost to a chunk boundary would be a silently missing step, so all three are
    // asserted rather than just the first.
    expect(stages).toEqual(["retrieving", "generating", "validating"])
    expect(result.kind).toBe("answered")
    expect(result.conversationId).toBe("c1")
  })

  it("falls back to the plain route when the stream route is absent", async () => {
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url)
        return url.endsWith("/stream")
          ? new Response(JSON.stringify({ error: "not found" }), { status: 404 })
          : new Response(JSON.stringify(answered), { status: 200 })
      }),
    )

    const result = await sendMessageWithProgress(cfg, { message: "hours?" }, () => {})
    expect(result.kind).toBe("answered")
    expect(calls).toHaveLength(2)
  })

  it("reports a rate limit without asking the question a second time", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      sendMessageWithProgress(cfg, { message: "hours?" }, () => {}),
    ).rejects.toThrow("wait 3 seconds")
    // One request. Retrying a 429 on a route that bills per answer is not a harmless retry.
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("does not re-ask when the stream ends without a result", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(['event: progress\ndata: {"stage":"generating"}\n\n']),
    )
    vi.stubGlobal("fetch", fetchMock)

    // The server may already have answered, recorded and billed the question; asking again
    // would charge the business twice for one customer message.
    await expect(
      sendMessageWithProgress(cfg, { message: "hours?" }, () => {}),
    ).rejects.toThrow(/temporarily unavailable/i)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
