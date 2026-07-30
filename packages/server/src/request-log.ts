import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * One line per request.
 *
 * The server logged failures and nothing else, so a running QuidChat looked identical whether it
 * was answering hundreds of customers or none. An operator checking whether their assistant is
 * being used, or why a particular answer was slow, had nothing to read.
 *
 * Deliberately one line and no more. A request log that wraps is a request log people stop
 * reading, and everything worth knowing about a chat turn — did it answer, how long did it take,
 * for whom — fits on one.
 */

export type LogFormat = "text" | "json" | "off"

/**
 * Reads the format from the environment.
 *
 * Text by default rather than off: a server whose log is silent looks dead, and the first thing
 * anyone does when they think a deployment is broken is look at its output. JSON is for whoever
 * ships these to something that parses them.
 */
export function logFormatFrom(env: Record<string, string | undefined>): LogFormat {
  const raw = (env.QUIDCHAT_LOG ?? "text").toLowerCase()
  return raw === "json" || raw === "off" ? raw : "text"
}

/** Health checks arrive every few seconds forever and say nothing about the product. */
const QUIET_PATHS = new Set(["/health", "/v1/health"])

/**
 * Attaches the logger to one request.
 *
 * Timed from here to `finish` rather than from the handler, so the number includes everything the
 * customer waited for. Hooked on the response rather than awaited around the handler because the
 * streaming route finishes long after its promise resolves.
 */
export function logRequest(args: {
  req: IncomingMessage
  res: ServerResponse
  format: LogFormat
  now?: () => number
  write?: (line: string) => void
}): void {
  const { req, res, format } = args
  if (format === "off") return

  const path = (req.url ?? "/").split("?")[0] ?? "/"
  if (QUIET_PATHS.has(path)) return

  const now = args.now ?? (() => Date.now())
  const write = args.write ?? ((line: string) => console.log(line))
  const started = now()

  res.on("finish", () => {
    const ms = now() - started
    const method = req.method ?? "GET"
    const status = res.statusCode
    if (format === "json") {
      write(JSON.stringify({ method, path, status, ms }))
      return
    }
    // Padded so a column of these lines up, which is most of what makes a log skimmable.
    write(`${method.padEnd(6)} ${String(status).padEnd(3)} ${String(ms).padStart(5)}ms  ${path}`)
  })
}
