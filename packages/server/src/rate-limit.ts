/**
 * Request rate limiting.
 *
 * The monthly budget bounds what a tenant can spend in total; it does nothing about how
 * fast. A script with a valid slug and a spoofed `Origin` header can burn a month's budget
 * in under a minute, and the tenant finds out when their assistant starts refusing every
 * customer. Rate limiting is what makes the budget a budget rather than a ceiling reached
 * on the first bad afternoon.
 *
 * A token bucket rather than a fixed window, because a fixed window has an edge: twice the
 * limit goes through in the two seconds spanning a window boundary, and a limiter that can
 * be doubled by waiting for the right moment is not a limit. The bucket refills
 * continuously, so the sustained rate is exactly `refillPerSecond` no matter when requests
 * arrive, while `capacity` sets how much of a burst is tolerated — a visitor opening the
 * widget and asking three quick questions is normal traffic, not abuse.
 *
 * In-memory and therefore per-process: two instances behind a load balancer allow twice the
 * configured rate. That is a deliberate trade rather than an oversight. A shared limiter
 * needs Redis or a Postgres round trip on every request, and this is the tier where neither
 * exists — QuidChat's whole premise is that one process on one small server works. The
 * budget guard is the backstop that IS shared, because it lives in the database.
 */

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

export type RateLimitConfig = {
  /** Maximum burst. Also the bucket's starting level, so a first request always passes. */
  capacity: number
  /** Sustained requests per second once the burst is spent. */
  refillPerSecond: number
}

type Bucket = { tokens: number; lastRefillMs: number }

/**
 * Entries are dropped once a bucket has been idle long enough to have refilled completely:
 * at that point it is indistinguishable from a fresh one, so keeping it only costs memory.
 * Without this an attacker rotating source addresses grows the map without bound, which
 * turns the defence into the vulnerability.
 */
const PRUNE_INTERVAL_MS = 60_000

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly config: RateLimitConfig
  /** Injected so tests can advance time without sleeping, and so the pruning and refill
   *  logic is exercised against exact instants rather than whatever the scheduler gave us. */
  private readonly now: () => number
  private lastPruneMs: number

  constructor(config: RateLimitConfig, now: () => number = Date.now) {
    if (config.capacity <= 0) throw new Error("rate limit capacity must be positive")
    if (config.refillPerSecond <= 0) throw new Error("rate limit refill must be positive")
    this.config = config
    this.now = now
    this.lastPruneMs = now()
  }

  /**
   * Takes one token for `key`, or reports how long to wait.
   *
   * `retryAfterSeconds` is rounded up and floored at 1: rounding down would tell a client
   * to retry at an instant when the token still is not there, and a `Retry-After: 0` reads
   * as "immediately", which invites exactly the tight loop the limit exists to stop.
   */
  check(key: string): RateLimitDecision {
    const nowMs = this.now()
    this.pruneIfDue(nowMs)

    const bucket = this.buckets.get(key) ?? { tokens: this.config.capacity, lastRefillMs: nowMs }
    const elapsedSeconds = Math.max(0, nowMs - bucket.lastRefillMs) / 1000
    const tokens = Math.min(
      this.config.capacity,
      bucket.tokens + elapsedSeconds * this.config.refillPerSecond,
    )

    if (tokens < 1) {
      // The clock still advances on a rejected request. Leaving `lastRefillMs` behind would
      // make every rejection re-credit the same elapsed time on the next call, so a client
      // hammering the endpoint would refill faster than one that waits.
      this.buckets.set(key, { tokens, lastRefillMs: nowMs })
      const deficit = 1 - tokens
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.config.refillPerSecond)),
      }
    }

    this.buckets.set(key, { tokens: tokens - 1, lastRefillMs: nowMs })
    return { allowed: true }
  }

  /** Visible for tests: how many keys are currently tracked. */
  size(): number {
    return this.buckets.size
  }

  private pruneIfDue(nowMs: number): void {
    if (nowMs - this.lastPruneMs < PRUNE_INTERVAL_MS) return
    this.lastPruneMs = nowMs
    const fullRefillMs = (this.config.capacity / this.config.refillPerSecond) * 1000
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.lastRefillMs >= fullRefillMs) this.buckets.delete(key)
    }
  }
}

/**
 * The limits QuidChat ships with.
 *
 * Both are checked, and both must pass. The per-visitor limit protects the tenant's budget
 * from one abusive client; the per-tenant limit protects it from a distributed one, where
 * every individual address looks reasonable. Neither alone covers the other's case.
 *
 * The numbers are set for a human asking questions. Ten in a burst then one every four
 * seconds is far more than a customer service conversation needs, and far less than a
 * script wants.
 */
export const DEFAULT_VISITOR_LIMIT: RateLimitConfig = { capacity: 10, refillPerSecond: 0.25 }
export const DEFAULT_TENANT_LIMIT: RateLimitConfig = { capacity: 60, refillPerSecond: 2 }

/**
 * Both limits behind one call.
 *
 * The visitor bucket is checked first and only debited when it passes, so a request already
 * rejected as too fast for one visitor does not also consume the tenant's allowance — one
 * request must cost at most one token from each bucket, or a single hammering client would
 * exhaust the tenant limit and take every other customer down with it.
 */
export class ChatRateLimiter {
  private readonly perVisitor: RateLimiter
  private readonly perTenant: RateLimiter

  constructor(
    visitor: RateLimitConfig = DEFAULT_VISITOR_LIMIT,
    tenant: RateLimitConfig = DEFAULT_TENANT_LIMIT,
    now: () => number = Date.now,
  ) {
    this.perVisitor = new RateLimiter(visitor, now)
    this.perTenant = new RateLimiter(tenant, now)
  }

  check(args: { tenantId: string; visitorId: string }): RateLimitDecision {
    // Keyed by tenant AND visitor: the same address talking to two businesses on one
    // deployment is two conversations, and one should not throttle the other.
    const visitor = this.perVisitor.check(`${args.tenantId}:${args.visitorId}`)
    if (!visitor.allowed) return visitor
    return this.perTenant.check(args.tenantId)
  }
}
