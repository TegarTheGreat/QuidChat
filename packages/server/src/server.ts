import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Provider, Store } from "@quidchat/core"
import { createStore, type QuidDb } from "@quidchat/db"
import { handleAdminRequest } from "./admin.js"
import { handleChannelWebhook } from "./channels.js"
import { handleChat } from "./chat.js"
import { handleWidgetAsset } from "./widget-asset.js"

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

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const pathname = stripVersionPrefix(url.pathname)

    if (pathname === "/chat/stream") {
      handleChat(req, res, { db: deps.db, store, provider: deps.provider, logError }, true).catch((e: unknown) => {
        logError("unhandled error in chat stream route", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    if (pathname === "/chat") {
      handleChat(req, res, { db: deps.db, store, provider: deps.provider, logError }).catch((e: unknown) => {
        logError("unhandled error in chat route", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
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
        db: deps.db, store, provider: deps.provider, env, logError,
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
        db: deps.db, store, provider: deps.provider, logError, adminToken: env.QUIDCHAT_ADMIN_TOKEN,
      }).catch((e: unknown) => {
        logError("unhandled error in admin route", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    sendJson(res, 404, { error: "not found" })
  })
}
