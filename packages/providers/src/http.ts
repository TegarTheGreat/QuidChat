/**
 * The HTTP behaviour every provider adapter needs and none of them had.
 *
 * Two things were missing, and both are the kind that only hurt in production.
 *
 * There was no timeout. A provider that accepts a connection and then says nothing held the
 * customer's request open until the socket died — minutes, from the point of view of someone
 * waiting for an answer on a shop's website — and held a database transaction and a rate-limit
 * slot the whole time.
 *
 * There was no retry. A `429` or a `503` is the provider saying "not now", and every one of them
 * emits those under ordinary load. Turning that into a refusal spends the customer's question,
 * records an escalation that reads as missing content, and tells the visitor the assistant cannot
 * help — when waiting half a second would have answered them.
 *
 * What is NOT retried matters as much: a bad key, an unknown model, and a malformed response are
 * all conditions that will repeat exactly, so retrying them wastes the customer's time to reach
 * the same answer.
 */

/** Per attempt, not for the whole call. */
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_ATTEMPTS = 3
/** Grows between attempts so a provider under load is not hammered by everyone at once. */
const BACKOFF_MS = [500, 1500]

export type RetryOptions = {
  timeoutMs?: number
  attempts?: number
  /** Injected so a test can exercise the backoff without waiting for it. */
  sleep?: (ms: number) => Promise<void>
}

/** A status the provider will very likely answer differently a moment later. */
function isTransient(status: number): boolean {
  // 429 is explicit. 408 and 425 are the request timing out or arriving too early. 5xx is the
  // provider itself, except 501: "not implemented" will still not be implemented next time.
  return status === 429 || status === 408 || status === 425 || (status >= 500 && status !== 501)
}

/**
 * How long the provider asked us to wait, when it said.
 *
 * `Retry-After` is the provider telling us exactly when it will be ready, and ignoring it in
 * favour of a guess is how a client gets rate limited twice. Capped, because a provider that asks
 * for an hour is not something to hold a customer's question open for.
 */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after")
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, 10_000)
}

/**
 * Runs one request, with a timeout, retrying only what is worth retrying.
 *
 * Returns the final `Response` — including a failing one, because turning a status into a typed
 * error is the adapter's job and it knows which of its own statuses mean what. Throws only when
 * there was no response at all after every attempt.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!)
    }

    let res: Response
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (cause) {
      // A refused connection, a DNS failure, or our own timeout. All are worth another go, and
      // the last one is kept so the caller can report what actually happened.
      lastError = cause
      continue
    }

    if (attempt < attempts - 1 && isTransient(res.status)) {
      const asked = retryAfterMs(res)
      if (asked !== null) await sleep(asked)
      lastError = new Error(`${url} answered ${res.status}`)
      continue
    }
    return res
  }

  throw lastError ?? new Error(`${url} could not be reached`)
}
