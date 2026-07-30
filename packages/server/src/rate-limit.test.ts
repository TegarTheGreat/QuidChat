import { describe, expect, it } from "vitest"
import { ChatRateLimiter, RateLimiter } from "./rate-limit.js"

/** A controllable clock. Real time would make the refill arithmetic untestable. */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs
  return { now: () => nowMs, advance: (seconds: number) => (nowMs += seconds * 1000) }
}

describe("RateLimiter", () => {
  it("allows a burst up to capacity and rejects the next request", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 }, clock.now)

    expect([1, 2, 3].map(() => limiter.check("a").allowed)).toEqual([true, true, true])

    const rejected = limiter.check("a")
    expect(rejected.allowed).toBe(false)
    expect(rejected.allowed === false && rejected.retryAfterSeconds).toBe(1)
  })

  it("refills at the configured sustained rate", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0.5 }, clock.now)
    limiter.check("a")
    limiter.check("a")
    expect(limiter.check("a").allowed).toBe(false)

    // Half a token after one second at 0.5/s — still short, and the limiter must not round
    // a partial token up into a whole one.
    clock.advance(1)
    expect(limiter.check("a").allowed).toBe(false)

    clock.advance(1)
    expect(limiter.check("a").allowed).toBe(true)
  })

  it("does not let a hammering client refill faster than one that waits", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 }, clock.now)
    limiter.check("a")

    // Rejected calls must still advance the bucket's clock. If they did not, each rejection
    // would re-credit the full elapsed second and the next call would pass early.
    clock.advance(0.5)
    expect(limiter.check("a").allowed).toBe(false)
    clock.advance(0.4)
    expect(limiter.check("a").allowed).toBe(false)
    clock.advance(0.05)
    expect(limiter.check("a").allowed).toBe(false)

    clock.advance(0.1)
    expect(limiter.check("a").allowed).toBe(true)
  })

  it("keeps keys independent", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 }, clock.now)
    expect(limiter.check("a").allowed).toBe(true)
    expect(limiter.check("a").allowed).toBe(false)
    expect(limiter.check("b").allowed).toBe(true)
  })

  it("drops fully refilled buckets so a rotating source cannot grow the map", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, clock.now)
    for (let i = 0; i < 50; i++) limiter.check(`visitor-${i}`)
    expect(limiter.size()).toBe(50)

    // Past both the prune interval and the time for every bucket to refill in full.
    clock.advance(61)
    limiter.check("live")
    expect(limiter.size()).toBe(1)
  })

  it("rejects a configuration that would block every request", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(/capacity/)
    expect(() => new RateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow(/refill/)
  })
})

describe("ChatRateLimiter", () => {
  it("throttles one visitor without spending the tenant's allowance", () => {
    const clock = fakeClock()
    const limiter = new ChatRateLimiter(
      { capacity: 1, refillPerSecond: 1 },
      { capacity: 3, refillPerSecond: 1 },
      clock.now,
    )

    expect(limiter.check({ tenantId: "t", visitorId: "noisy" }).allowed).toBe(true)
    // Ten rejected attempts from one visitor. If a rejection debited the tenant bucket too,
    // its three tokens would be gone and every other customer would be refused.
    for (let i = 0; i < 10; i++) {
      expect(limiter.check({ tenantId: "t", visitorId: "noisy" }).allowed).toBe(false)
    }

    expect(limiter.check({ tenantId: "t", visitorId: "other" }).allowed).toBe(true)
    expect(limiter.check({ tenantId: "t", visitorId: "third" }).allowed).toBe(true)
  })

  it("keeps one tenant's traffic from throttling another", () => {
    const clock = fakeClock()
    const limiter = new ChatRateLimiter(
      { capacity: 1, refillPerSecond: 1 },
      { capacity: 1, refillPerSecond: 1 },
      clock.now,
    )
    expect(limiter.check({ tenantId: "shop-a", visitorId: "v" }).allowed).toBe(true)
    expect(limiter.check({ tenantId: "shop-a", visitorId: "v" }).allowed).toBe(false)
    // Same address, different business on the same deployment: a separate conversation.
    expect(limiter.check({ tenantId: "shop-b", visitorId: "v" }).allowed).toBe(true)
  })
})
