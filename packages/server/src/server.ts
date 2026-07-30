import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Provider, Store } from "@quidchat/core"
import { createStore, type QuidDb } from "@quidchat/db"
import { handleAdminRequest } from "./admin.js"
import { handleChannelWebhook } from "./channels.js"
import { handleChat } from "./chat.js"
import { handlePanelAsset } from "./panel-asset.js"
import { handleWidgetConfig } from "./widget-config.js"
import { handleWidgetAsset } from "./widget-asset.js"
import { applyCors, handlePreflight, isPublicPath } from "./cors.js"
import { ChatRateLimiter, RateLimiter, type RateLimitConfig } from "./rate-limit.js"

export type ServerDeps = {
  db: QuidDb
  provider: Provider
  /** Defaults to `createStore(db)`. Injectable so a test can force a genuine store
   *  failure — e.g. a `searchChunks` that throws — without touching production
   *  wiring, to prove the 503 catch-all in `chat.ts` behaves correctly. */
  store?: Store
  /** Called for operational failures. Defaults to `console.error`. Injectable so tests
   *  can assert that a failure was logged rather than swallowed. */
  logError?: (message: string, cause: unknown) => void
  /** Defaults to `process.env`. Injectable so a test can exercise the admin token gate
   *  (unset vs. set, valid vs. invalid) without mutating real process state — see
   *  `admin.ts`'s `checkAdminAuth`. */
  env?: Record<string, string | undefined>
  /** Overrides the shipped rate limits. A test that wants to observe a 429 sets a capacity
   *  of one rather than issuing eleven real requests. */
  rateLimits?: { visitor?: RateLimitConfig; tenant?: RateLimitConfig }
  /** Overrides how many wrong admin tokens are tolerated. A test asserting the 429 should not
   *  have to send the shipped allowance of them first. */
  adminAuthLimit?: RateLimitConfig
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/**
 * Strips a leading `/v1` so every route below is defined exactly once and is reachable
 * both with and without the version prefix — see the module doc comment.
 */
function stripVersionPrefix(pathname: string): string {
  if (pathname === "/v1") return "/"
  if (pathname.startsWith("/v1/")) return pathname.slice(3)
  return pathname
}

/**
 * Wires the chat route, the admin API, and the widget asset to `node:http`. No
 * framework: each route is one `if`, one job.
 *
 * Every route below is reachable both unprefixed (`/chat`) and under `/v1`
 * (`/v1/chat`) — see `stripVersionPrefix`. Without a version prefix, any future change
 * to a response's shape would break every widget already pasted into a customer's
 * site; the unprefixed paths keep working too, so the existing widget and existing
 * tests do not break either.
 */
export function createServer(deps: ServerDeps): Server {
  const store = deps.store ?? createStore(deps.db)
  const logError = deps.logError ?? ((message: string, cause: unknown) => console.error(message, cause))
  const env = deps.env ?? process.env
  // One limiter for the whole server, built here rather than per request — a limiter
  // constructed inside the handler starts full every time and limits nothing at all.
  const rateLimiter = new ChatRateLimiter(
    deps.rateLimits?.visitor ?? undefined,
    deps.rateLimits?.tenant ?? undefined,
  )
  // Guesses at the admin token, counted per source address and only when a guess is wrong. Ten
  // to start with and one every ten seconds after: unnoticeable to anyone typing a token they
  // have, and useless to anyone trying tokens they do not.
  const failedAuthLimiter = new RateLimiter(
    deps.adminAuthLimit ?? { capacity: 10, refillPerSecond: 0.1 },
  )

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const pathname = stripVersionPrefix(url.pathname)

    // The widget runs on a business's own site, which is a different origin from this server in
    // every real deployment. Without these headers a browser refuses to hand the response to the
    // script, and refuses to send the request at all until a preflight succeeds — so the widget
    // worked from curl and from nowhere a customer would use it. Admin routes are excluded
    // deliberately: the panel is served by this process and is already same-origin.
    if (isPublicPath(pathname)) {
      if (handlePreflight(req, res)) return
      applyCors(req, res)
    }

    // A liveness probe. Deliberately touches no database: a health check that fails when
    // Postgres is briefly unreachable makes an orchestrator kill a process that would have
    // recovered on its own, turning a blip into an outage.
    if (pathname === "/health") {
      sendJson(res, 200, { status: "ok" })
      return
    }

    if (pathname === "/chat/stream") {
      handleChat(req, res, { db: deps.db, store, provider: deps.provider, logError, rateLimiter }, true).catch((e: unknown) => {
        logError("unhandled error in chat stream route", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    if (pathname === "/chat") {
      handleChat(req, res, { db: deps.db, store, provider: deps.provider, logError, rateLimiter }).catch((e: unknown) => {
        logError("unhandled error in chat route", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    // The admin panel. Mounted at /panel because /admin/* is the API — see panel-asset.ts.
    if (pathname === "/panel" || pathname.startsWith("/panel/")) {
      handlePanelAsset(res, pathname).catch((e: unknown) => {
        logError("unhandled error serving the admin panel", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    // The widget's public theme. Unauthenticated and origin-free like the bundle itself: it
    // runs in a visitor's browser before any conversation exists, which is exactly why the
    // handler returns presentation fields only and never the settings row.
    if (pathname === "/widget-config") {
      handleWidgetConfig(res, deps.db, url.searchParams.get("tenantSlug") ?? "").catch(
        (e: unknown) => {
          logError("unhandled error serving the widget config", e)
          if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
        },
      )
      return
    }

    if (pathname === "/quidchat.js") {
      handleWidgetAsset(res).catch((e: unknown) => {
        logError("unhandled error serving widget bundle", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    if (pathname.startsWith("/channels/")) {
      handleChannelWebhook(req, res, pathname, {
        db: deps.db, store, provider: deps.provider, env, logError, rateLimiter,
      }).catch((e: unknown) => {
        logError("unhandled error in channel webhook", e)
        // Still a 200: every one of these platforms retries a non-2xx webhook, and a
        // retry would re-answer a question that may already have been answered and
        // billed.
        if (!res.headersSent) sendJson(res, 200, { status: "error" })
      })
      return
    }

    if (pathname.startsWith("/admin/")) {
      handleAdminRequest(req, res, pathname, url.searchParams, {
        db: deps.db, store, provider: deps.provider, logError,
        adminToken: env.QUIDCHAT_ADMIN_TOKEN, env, failedAuthLimiter,
      }).catch((e: unknown) => {
        logError("unhandled error in admin route", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    sendJson(res, 404, { error: "not found" })
  })
}
