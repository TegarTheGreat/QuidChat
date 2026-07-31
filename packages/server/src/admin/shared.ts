import type { IncomingMessage, ServerResponse } from "node:http"
import type { Provider, Store } from "@quidchat/core"
import type { QuidDb } from "@quidchat/db"
import type { RateLimiter } from "../rate-limit.js"
import type { ModelLister } from "../tenant-provider.js"
import { lookupTenantBySlug } from "../tenant-lookup.js"

/**
 * The pieces every admin handler needs.
 *
 * Split out of `admin.ts` when it passed a thousand lines: the router, the auth gate and
 * twenty handlers in one file made the thing nobody wanted to read. Behaviour is unchanged —
 * this was a move, not a rewrite.
 */

/** Normalizes the `execute()` result, whose shape differs between drivers — see the
 *  identical helper in `chat.ts`, `tenant-lookup.ts`, `budget.ts`, and `@quidchat/db`'s
 *  `store.ts`. */
export function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/**
 * Admin bodies can carry pasted knowledge-base text (`POST /admin/sources/text`), which
 * is routinely far larger than a chat message — `chat.ts`'s 16 KiB bound would reject a
 * perfectly normal support article. Still bounded, though: an unbounded read is a
 * denial-of-service that requires no attacker skill at all — see `chat.ts`'s
 * `readBoundedBody`, which this mirrors.
 */
export const MAX_ADMIN_BODY_BYTES = 4 * 1024 * 1024

export async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_ADMIN_BODY_BYTES) {
        tooLarge = true
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}

/** Reads and JSON-parses a request body, sending the appropriate `400` and returning
 *  `undefined` itself on every failure so callers can just check for `undefined`. */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const contentType = req.headers["content-type"] ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    sendJson(res, 400, { error: "expected application/json" })
    return undefined
  }
  const raw = await readBoundedBody(req)
  if (raw === null) {
    sendJson(res, 400, { error: "request body too large" })
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" })
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) {
    sendJson(res, 400, { error: "expected a JSON object body" })
    return undefined
  }
  return parsed as Record<string, unknown>
}

/**
 * Renders a JS string array as a Postgres array literal, passed as a BIND parameter and
 * cast with `::text[]` at the call site — copied from `packages/cli/src/init.ts`'s
 * `pgTextArray`, which explains why: passing the array directly as a bind parameter
 * flattens it to a single scalar, so a `text[]` column receives one string and the
 * insert fails. Quotes are escaped because these values are operator- or
 * business-owner-supplied.
 */
export function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`
}

export type AdminDeps = {
  db: QuidDb
  store: Store
  provider: Provider
  logError: (message: string, cause: unknown) => void
  /** `undefined` exactly when `QUIDCHAT_ADMIN_TOKEN` is not set in the environment —
   *  every admin route then refuses with `503` rather than defaulting to open. */
  adminToken: string | undefined
  /** Asks a tenant's provider which models it has — see `tenant-provider.ts`. */
  listModels?: ModelLister
  /** The process environment, for `QUIDCHAT_SECRET_KEY`. Injected rather than read from
   *  `process.env` here so a test can exercise a missing or wrong key without touching real
   *  process state — the same reason `adminToken` is passed in. */
  env?: Record<string, string | undefined>
  /** Bounds guesses at the admin token. Optional so a test can construct deps without one. */
  failedAuthLimiter?: RateLimiter
}

/** Resolves `slug` to a tenant id via the same public lookup `/chat` uses, sending the
 *  appropriate `400`/`404` and returning `null` itself on every failure. Deliberately
 *  NOT a bypass of its own: this reuses the one documented cross-tenant lookup rather
 *  than adding a second. */
export async function resolveTenantOr404(
  res: ServerResponse,
  db: QuidDb,
  slug: string | null,
): Promise<string | null> {
  if (!slug) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return null
  }
  const identity = await lookupTenantBySlug(db, slug)
  if (!identity) {
    sendJson(res, 404, { error: "unknown tenant" })
    return null
  }
  return identity.tenantId
}
