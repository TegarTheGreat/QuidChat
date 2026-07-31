import { describe, expect, it } from "vitest"
import { clientAddress, trustedProxyHops } from "./client-address.js"

function request(socket: string, xff?: string): never {
  return {
    socket: { remoteAddress: socket },
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  } as never
}

describe("who the request came from", () => {
  it("uses the socket when no proxy is declared", () => {
    // The default. A header nobody vouched for must not decide who someone is.
    expect(clientAddress(request("203.0.113.9", "1.2.3.4"), 0)).toBe("203.0.113.9")
  })

  it("reads through the number of proxies the operator actually runs", () => {
    // One nginx in front: it appends the client it saw, so the chain is just the client.
    expect(clientAddress(request("127.0.0.1", "203.0.113.9"), 1)).toBe("203.0.113.9")
    // Two hops — a CDN then nginx: "client, cdn". Counting in from the right skips the proxy.
    expect(clientAddress(request("127.0.0.1", "203.0.113.9, 198.51.100.7"), 2)).toBe("203.0.113.9")
  })

  it("ignores addresses the client added beyond the trusted hops", () => {
    // The visitor prepends whatever they like. With one trusted proxy, only the entry that proxy
    // appended is evidence; everything to its left is the visitor talking about themselves.
    expect(clientAddress(request("127.0.0.1", "10.0.0.1, 203.0.113.9"), 1)).toBe("203.0.113.9")
  })

  it("falls back to the socket when the chain is shorter than promised", () => {
    // A request that reached the server without passing the proxy. Reading the one entry present
    // would let anyone bypass their rate limit and claim another visitor's conversation.
    expect(clientAddress(request("203.0.113.9", "10.0.0.1"), 2)).toBe("203.0.113.9")
    expect(clientAddress(request("203.0.113.9"), 1)).toBe("203.0.113.9")
    expect(clientAddress(request("203.0.113.9", "   "), 1)).toBe("203.0.113.9")
  })

  it("treats an unreadable setting as no proxy at all", () => {
    // Guessing in the permissive direction here hands identity to a header.
    for (const raw of ["", "  ", "yes", "true", "-1", "0", undefined]) {
      expect(trustedProxyHops({ QUIDCHAT_TRUST_PROXY: raw }), String(raw)).toBe(0)
    }
    expect(trustedProxyHops({ QUIDCHAT_TRUST_PROXY: "1" })).toBe(1)
    expect(trustedProxyHops({ QUIDCHAT_TRUST_PROXY: "2" })).toBe(2)
  })
})
