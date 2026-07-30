import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { describe, expect, it } from "vitest"
import { logFormatFrom, logRequest } from "./request-log.js"

/** A response that can be told it finished, which is when the line is written. */
function fakeExchange(url: string, method = "POST", statusCode = 200) {
  const res = new EventEmitter() as ServerResponse
  res.statusCode = statusCode
  return { req: { url, method } as IncomingMessage, res, finish: () => res.emit("finish") }
}

describe("logFormatFrom", () => {
  it("logs in text unless told otherwise", () => {
    // Not off by default: a server whose output is silent looks dead, and its log is the first
    // thing anyone reads when they think a deployment is broken. Under vitest the default flips,
    // so this asserts the configured values and the fallback rather than the bare default — see
    // the test below for that.
    expect(logFormatFrom({ QUIDCHAT_LOG: "text" })).toBe("text")
    expect(logFormatFrom({ QUIDCHAT_LOG: "json" })).toBe("json")
    expect(logFormatFrom({ QUIDCHAT_LOG: "off" })).toBe("off")
    expect(logFormatFrom({ QUIDCHAT_LOG: "JSON" })).toBe("json")
    // An unrecognised value falls back rather than silencing the log, which is the outcome
    // nobody would want from a typo.
    expect(logFormatFrom({ QUIDCHAT_LOG: "verbose" })).toBe("text")
  })

  it("stays quiet under vitest unless a format is asked for", () => {
    // A suite starts dozens of servers and makes hundreds of requests; a line for each buries the
    // one thing a contributor is reading the output for.
    expect(process.env.VITEST).toBeTruthy()
    expect(logFormatFrom({})).toBe("off")
    // Asking for one still works, which is what makes a failing test debuggable.
    expect(logFormatFrom({ QUIDCHAT_LOG: "text" })).toBe("text")
  })
})

describe("logRequest", () => {
  it("writes one line when the response finishes, with the status and the duration", () => {
    const lines: string[] = []
    let clock = 1000
    const { req, res, finish } = fakeExchange("/v1/chat")
    logRequest({ req, res, format: "text", now: () => clock, write: (l) => lines.push(l) })

    // Nothing yet: the duration is only known once the customer has their answer.
    expect(lines).toHaveLength(0)
    clock = 1250
    finish()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("POST")
    expect(lines[0]).toContain("200")
    expect(lines[0]).toContain("250ms")
    expect(lines[0]).toContain("/v1/chat")
  })

  it("writes one object per request in json", () => {
    const lines: string[] = []
    let clock = 0
    const { req, res, finish } = fakeExchange("/v1/chat?tenantSlug=shop", "POST", 429)
    logRequest({ req, res, format: "json", now: () => clock, write: (l) => lines.push(l) })
    clock = 12
    finish()

    // The query string is dropped: it carries a tenant slug and nothing else worth a log line,
    // and paths that vary per request make a log impossible to aggregate.
    expect(JSON.parse(lines[0]!)).toEqual({ method: "POST", path: "/v1/chat", status: 429, ms: 12 })
  })

  it("says nothing about health checks, and nothing at all when off", () => {
    const lines: string[] = []
    for (const path of ["/health", "/v1/health"]) {
      const { req, res, finish } = fakeExchange(path, "GET")
      logRequest({ req, res, format: "text", write: (l) => lines.push(l) })
      finish()
    }
    // A probe arrives every few seconds forever and says nothing about the product.
    expect(lines).toHaveLength(0)

    const { req, res, finish } = fakeExchange("/v1/chat")
    logRequest({ req, res, format: "off", write: (l) => lines.push(l) })
    finish()
    expect(lines).toHaveLength(0)
  })
})
