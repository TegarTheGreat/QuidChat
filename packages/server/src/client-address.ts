import type { IncomingMessage } from "node:http"

/**
 * Who the request came from.
 *
 * `req.socket.remoteAddress` is the machine that opened the TCP connection. Behind a reverse
 * proxy — which is every deployment that serves HTTPS, and the README's own instructions — that
 * is the proxy, identically for every visitor. Three things quietly stopped working:
 *
 *   - The per-visitor rate limit became one shared bucket, so a single abusive client no longer
 *     throttled itself; it throttled everyone, while the tenant-wide limit that was supposed to
 *     be the second line of defence became the only one.
 *   - The failed-admin-token limiter became one shared bucket too, so an attacker's wrong
 *     guesses lock out the real administrator.
 *   - `conversations.visitor_id` became the same value for everyone, which turns the ownership
 *     check on a supplied `conversationId` into a no-op — and that check exists precisely because
 *     a conversation id was once a capability anyone could present.
 *
 * Trusting `X-Forwarded-For` unconditionally would be worse than ignoring it: the header is
 * client-supplied, so any visitor could name any address, bypass their own rate limit, and claim
 * another visitor's conversation outright. It is therefore opt-in, and the operator says how many
 * proxies they actually run.
 */

/** Reads `QUIDCHAT_TRUST_PROXY` — the number of proxies in front of this server. 0, or absent,
 *  means the socket address is the truth. */
export function trustedProxyHops(env: Record<string, string | undefined>): number {
  const raw = env.QUIDCHAT_TRUST_PROXY
  if (raw === undefined || raw.trim() === "") return 0
  const hops = Number.parseInt(raw, 10)
  // A malformed value means nobody knows how many proxies there are, and guessing in the
  // permissive direction would let a header decide who someone is. Zero is the safe reading.
  return Number.isFinite(hops) && hops > 0 ? hops : 0
}

/**
 * The client's address, honouring `X-Forwarded-For` only as far as the operator has vouched for.
 *
 * Each proxy appends the address it saw, so the rightmost entries are the ones added by the
 * proxies nearest this server. Counting `hops` in from the right lands on the address the
 * outermost trusted proxy observed — everything left of it was supplied by the client and is not
 * evidence of anything.
 */
export function clientAddress(
  req: IncomingMessage,
  hops: number,
): string {
  const socketAddress = req.socket.remoteAddress ?? "unknown"
  if (hops <= 0) return socketAddress

  const header = req.headers["x-forwarded-for"]
  const raw = Array.isArray(header) ? header.join(",") : header
  if (typeof raw !== "string" || raw.trim() === "") return socketAddress

  const chain = raw.split(",").map((part) => part.trim()).filter((part) => part !== "")
  if (chain.length === 0) return socketAddress

  // Fewer entries than trusted hops means the chain is shorter than the operator described —
  // a direct request that skipped the proxy, or a misconfiguration. Falling back to the socket
  // is the reading that cannot be forged.
  const index = chain.length - hops
  return index >= 0 && index < chain.length ? chain[index]! : socketAddress
}
