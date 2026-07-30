import type { DbConfig } from "@quidchat/db"

export type ServeConfig = {
  db: DbConfig
  port: number
  /** Where the database came from, so `serve` can report it rather than imply it. */
  dbOrigin: string
}

/** Default port. 3210 is unassigned by IANA and unlikely to collide with a dev server. */
const DEFAULT_PORT = 3210

/**
 * Reads serve configuration from the environment.
 *
 * Takes `env` as an argument rather than reading `process.env` itself, for the same
 * reason `resolveProviders` does: it makes this testable without mutating real process
 * state, and it keeps the rule that only the outermost layer touches the process.
 *
 * `DATABASE_URL` selects the managed Postgres tier. Its absence selects PGlite with an
 * on-disk directory — NOT in-memory. An in-memory default would look like it worked and
 * then lose every document and conversation on restart, which is the kind of data loss
 * a user discovers days later and cannot undo.
 */
export function readServeConfig(env: Record<string, string | undefined>): ServeConfig {
  const port = parsePort(env.PORT)

  if (env.DATABASE_URL) {
    return {
      db: { kind: "postgres", url: env.DATABASE_URL },
      port,
      dbOrigin: "DATABASE_URL",
    }
  }

  // `??` alone would let an empty string through as a directory name, so an operator
  // who exports the variable without a value would get a database rooted at "".
  const configured = env.QUIDCHAT_DATA_DIR?.trim()

  // An explicit opt-in to ephemeral storage, useful for demos, CI, and throwaway
  // containers. It has to be asked for by name — see the note above about why it is not
  // the default.
  if (configured === "memory") {
    return { db: { kind: "pglite" }, port, dbOrigin: "PGlite in memory (not persisted)" }
  }

  const dataDir = configured && configured.length > 0 ? configured : "./.quidchat/data"
  return {
    db: { kind: "pglite", dataDir },
    port,
    dbOrigin: `PGlite at ${dataDir}`,
  }
}

/**
 * A malformed `PORT` is an error, not a silent fall back to the default.
 *
 * Falling back would start the server on a port the operator did not ask for, and they
 * would find out from a failing health check somewhere else entirely.
 */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT
  const port = Number(raw)
  // Zero is allowed and meaningful: it asks the OS for any free port. Tests rely on it,
  // and so does anything that maps ports externally, so rejecting it would be wrong.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got: ${raw}`)
  }
  return port
}
