import { describe, expect, it, vi } from "vitest"
import { fetchWithRetry } from "./http.js"

/** Never actually waits: the backoff is the thing under test, not the clock. */
const instantSleep = { sleep: async () => {} }

function responder(statuses: number[], headers: Record<string, string> = {}) {
  let call = 0
  const impl = vi.fn(async () => {
    const status = statuses[Math.min(call, statuses.length - 1)]!
    call++
    return new Response("{}", { status, headers })
  })
  return impl as unknown as typeof fetch & { mock: { calls: unknown[] } }
}

describe("fetchWithRetry", () => {
  it("returns the first success without retrying", async () => {
    const impl = responder([200])
    const res = await fetchWithRetry(impl, "https://x.test", {}, instantSleep)
    expect(res.status).toBe(200)
    expect(impl.mock.calls).toHaveLength(1)
  })

  it("retries a provider saying not now, and answers when it relents", async () => {
    // Every provider emits these under ordinary load. Turning one into a refusal spends the
    // customer's question and records an escalation that reads as missing content.
    for (const transient of [429, 503, 500, 408]) {
      const impl = responder([transient, 200])
      const res = await fetchWithRetry(impl, "https://x.test", {}, instantSleep)
      expect(res.status, String(transient)).toBe(200)
      expect(impl.mock.calls.length, String(transient)).toBe(2)
    }
  })

  it("does not retry what will fail the same way again", async () => {
    // A bad key, an unknown model, a malformed request: retrying spends the customer's time to
    // reach the same answer. 501 is in here too — not implemented will still not be next time.
    for (const permanent of [400, 401, 403, 404, 422, 501]) {
      const impl = responder([permanent])
      const res = await fetchWithRetry(impl, "https://x.test", {}, instantSleep)
      expect(res.status, String(permanent)).toBe(permanent)
      expect(impl.mock.calls.length, String(permanent)).toBe(1)
    }
  })

  it("gives up after a bounded number of attempts and returns what it got", async () => {
    const impl = responder([503])
    const res = await fetchWithRetry(impl, "https://x.test", {}, { ...instantSleep, attempts: 3 })
    // The last response is handed back rather than thrown: turning a status into a typed error is
    // the adapter's job, and it knows which of its own statuses mean what.
    expect(res.status).toBe(503)
    expect(impl.mock.calls).toHaveLength(3)
  })

  it("waits as long as the provider asked, not as long as we guessed", async () => {
    const waited: number[] = []
    const impl = responder([429, 200], { "retry-after": "2" })
    await fetchWithRetry(impl, "https://x.test", {}, {
      sleep: async (ms) => {
        waited.push(ms)
      },
    })
    // Retry-After is the provider saying exactly when it will be ready. Ignoring it in favour of
    // a guess is how a client gets rate limited twice.
    expect(waited).toContain(2000)
  })

  it("caps how long it will hold a customer's question for", async () => {
    const waited: number[] = []
    const impl = responder([429, 200], { "retry-after": "3600" })
    await fetchWithRetry(impl, "https://x.test", {}, {
      sleep: async (ms) => {
        waited.push(ms)
      },
    })
    // A provider asking for an hour is not something to keep someone waiting on a shop's website
    // for; the request fails and the pipeline refuses honestly instead.
    expect(Math.max(...waited)).toBeLessThanOrEqual(10_000)
  })

  it("retries a connection that never answered, and reports the last failure", async () => {
    let calls = 0
    const impl = (async () => {
      calls++
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch

    await expect(
      fetchWithRetry(impl, "https://x.test", {}, { ...instantSleep, attempts: 3 }),
    ).rejects.toThrow(/ECONNREFUSED/)
    expect(calls).toBe(3)
  })

  it("puts a deadline on every attempt", async () => {
    let signal: AbortSignal | undefined
    const impl = (async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    await fetchWithRetry(impl, "https://x.test", {}, instantSleep)
    // Without this a provider that accepts the connection and then says nothing holds the
    // request open until the socket dies, with a rate-limit slot held the whole time.
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})
