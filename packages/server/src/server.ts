import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Provider, Store } from "@quidchat/core"
import { createStore, type QuidDb } from "@quidchat/db"
import { handleChat } from "./chat.js"

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
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/** Wires the chat route to `node:http`. No framework: one path, one method, one job. */
export function createServer(deps: ServerDeps): Server {
  const store = deps.store ?? createStore(deps.db)
  const logError = deps.logError ?? ((message: string, cause: unknown) => console.error(message, cause))

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]

    if (path === "/chat") {
      handleChat(req, res, { db: deps.db, store, provider: deps.provider, logError }).catch((e: unknown) => {
        logError("unhandled error in chat route", e)
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" })
      })
      return
    }

    sendJson(res, 404, { error: "not found" })
  })
}
