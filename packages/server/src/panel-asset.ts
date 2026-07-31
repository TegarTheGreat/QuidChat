import { readFile } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"

/**
 * Serves the built admin panel.
 *
 * Every setting in QuidChat is meant to be reachable from the panel, and the panel was a
 * Vite app nobody hosted: an operator who installed the CLI or ran the container got the API
 * and no interface, and configuring their assistant meant running a dev server from a source
 * checkout. Shipping the API without the interface makes "configure it in the panel" advice
 * an operator cannot follow.
 *
 * Mounted at `/panel` rather than `/admin`, because `/admin/*` is the API. Two namespaces
 * that overlap would make every future route a decision about whether it is a page or an
 * endpoint, and the first mistake would shadow a working API route with an HTML page.
 */

const PANEL_ROOT = fileURLToPath(new URL("../../admin/dist/", import.meta.url))

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".")
  return (dot >= 0 ? CONTENT_TYPES[path.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream"
}

/**
 * Turns a request path into a file under the panel's build directory, or `null` when it
 * escapes it.
 *
 * The check is on the RESOLVED path, not on the raw request: `..` in a URL survives
 * `decodeURIComponent`, and a check that only rejected a literal ".." string would be walked
 * past with `%2e%2e%2f`. Serving the process's own files — `.env`, a private key, the SQLite
 * of a neighbouring app — is the entire class of bug this prevents, so it is checked once, at
 * the end, on the thing actually about to be read.
 */
export function resolvePanelPath(pathname: string): string | null {
  const withoutPrefix = pathname.replace(/^\/panel\/?/, "")
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutPrefix)
  } catch {
    // A malformed escape sequence is not a filename anyone legitimately asks for.
    return null
  }
  // A directory request is the app itself; the panel is a single-page app, so every path it
  // owns resolves to index.html and the router in the browser takes it from there.
  const relative = decoded === "" || decoded.endsWith("/") ? `${decoded}index.html` : decoded
  const resolved = fileURLToPath(new URL(relative, `file://${PANEL_ROOT}`))
  return resolved.startsWith(PANEL_ROOT) ? resolved : null
}

/** `GET /panel` and everything under it. */
/**
 * Sent with the panel's HTML, not with its hashed assets.
 *
 * The admin token lives in this page's `sessionStorage`, and a token is the whole product: it
 * renames tenants, reads every transcript and deletes a business outright. So the question worth
 * answering is what an injected script could do here, and `script-src 'self'` is the answer —
 * the build emits one module tag and one stylesheet, no inline script anywhere, so nothing is
 * given up by refusing them.
 *
 * `'unsafe-inline'` stays on styles because the panel's menus and dialogs position themselves by
 * writing a `style` attribute, and CSP does not distinguish that from an injected stylesheet. A
 * style attribute cannot execute; dropping it would break every dropdown to buy nothing.
 *
 * `connect-src` is deliberately absent. The panel is served by the API it talks to in every
 * documented deployment, but `VITE_API_BASE` exists so it can be built against another origin,
 * and a header that silently breaks that deployment is worse than the exfiltration path it would
 * close after an attacker already has script execution.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // Says the same thing as x-frame-options to browsers that read this instead.
    "frame-ancestors 'none'",
  ].join("; "),
  // A panel URL can carry a tenant slug, and there is no reason for it to travel to anyone.
  "referrer-policy": "no-referrer",
}

export async function handlePanelAsset(res: ServerResponse, pathname: string): Promise<void> {
  const filePath = resolvePanelPath(pathname)
  if (!filePath) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ error: "not found" }))
    return
  }

  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "EISDIR") {
      throw e
    }
    // A missing asset and a missing build are different problems with the same symptom — a
    // panel that will not load — so they get different answers. An absent index.html means
    // nobody built the panel, and saying so beats a 404 that reads as "wrong URL".
    if (filePath.endsWith("index.html")) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" })
      res.end(
        JSON.stringify({
          error: "admin panel not built: packages/admin/dist/index.html is missing — run `pnpm build`",
        }),
      )
      return
    }
    // Any other unknown path under /panel belongs to the single-page app's router, so it is
    // answered with the app itself rather than a 404 the router never gets to see.
    return handlePanelAsset(res, "/panel/")
  }

  const isHtml = filePath.endsWith(".html")
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    ...(isHtml ? SECURITY_HEADERS : {}),
    // Vite puts a content hash in every asset filename, so those are immutable. index.html
    // is not hashed and must never be cached, or a browser keeps loading yesterday's HTML
    // pointing at asset names that no longer exist.
    "cache-control": isHtml ? "no-store" : "public, max-age=31536000, immutable",
    // The panel holds an admin token. Refusing to be framed removes the clickjacking path to
    // it, and it has no reason to appear inside anyone else's page.
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  })
  res.end(body)
}
