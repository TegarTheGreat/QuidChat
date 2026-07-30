import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Cross-origin access for the public widget routes.
 *
 * The product's headline instruction is to paste one script tag onto your own site. That site is
 * a different origin from the QuidChat server in every deployment that is not a demo, so a
 * browser will not let the widget read any response without these headers, and will not even
 * send the request without a successful preflight — `content-type: application/json` makes the
 * chat POST non-simple. Without this the widget worked from curl, from tests, and from nowhere a
 * customer would ever use it.
 *
 * ONLY the public widget surface gets these headers. The admin API deliberately does not: the
 * panel is served by this same process at `/panel`, so it is same-origin and needs nothing, and
 * an admin API reachable from any page on the internet is a very different thing to own.
 */

/** The routes a visitor's browser reaches from a business's own site. */
const PUBLIC_PATHS = new Set(["/chat", "/chat/stream", "/widget-config", "/quidchat.js", "/health"])

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname)
}

/**
 * Adds the headers that let a browser read the response.
 *
 * The requesting origin is echoed rather than `*`, for two reasons. `*` is incompatible with
 * credentialed requests, so echoing keeps the door open for cookie-based sessions later without
 * another breaking change. And echoing makes `Vary: Origin` meaningful, which is what stops a
 * shared cache handing one site's response to another.
 *
 * Echoing ANY origin is not a hole here, because CORS is not this product's access control: the
 * per-tenant origin allowlist is, it runs on the request itself, and it answers `403` for a site
 * that is not on it. Refusing the header instead would mean the browser hides that `403` and its
 * message — turning the single most common setup mistake into an unexplained failure.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (!origin) return
  res.setHeader("access-control-allow-origin", origin)
  res.setHeader("vary", "Origin")
}

/**
 * Answers a preflight.
 *
 * Returns true when it handled the request, so the caller stops. A preflight carries no body, so
 * the tenant is unknowable at this point and there is nothing to check it against — which is
 * fine: the preflight is not the authorization boundary, the actual request is.
 *
 * `access-control-max-age` matters more than it looks. Without it a browser preflights every
 * single message a visitor sends, doubling the request count on the one route that costs money.
 */
export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS") return false
  applyCors(req, res)
  res.writeHead(204, {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "content-length": "0",
  })
  res.end()
  return true
}
