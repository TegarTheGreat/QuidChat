import { randomBytes } from "node:crypto"
import { applyMigrations, createDb } from "@quidchat/db"
import { resolveProviders, type ResolveResult } from "@quidchat/providers"
import { createServer, startRetentionSchedule } from "@quidchat/server"
import { readServeConfig } from "./config.js"

export type ServeResult = {
  port: number
  close: () => Promise<void>
}

/**
 * Starts QuidChat: opens the database, applies migrations, resolves a provider from the
 * environment, and listens.
 *
 * `log` is injected rather than calling `console.log` directly so a test can assert what
 * an operator is told. What it is told matters: this is the only place that reports which
 * provider was chosen and which database is in use, and a start-up that hides those
 * decisions is what turns "zero configuration" from convenience into confusion.
 */
export async function serve(args: {
  env: Record<string, string | undefined>
  log?: (line: string) => void
}): Promise<ServeResult> {
  const log = args.log ?? ((line: string) => console.log(line))
  const config = readServeConfig(args.env)

  const resolved = resolveProviders(args.env)
  if (!resolved.provider) {
    // Refusing to start beats starting and failing on the first visitor question. The
    // trace explains exactly which keys were looked for, so the fix is one line away
    // instead of a guess.
    throw new Error(explainNoProvider(resolved))
  }

  log(`database: ${config.dbOrigin}`)
  const db = await createDb(config.db)
  await applyMigrations(db)
  log("migrations: applied")

  log(`provider: chat via ${resolved.chosen.chat}, embeddings via ${resolved.chosen.embed}`)

  // Started before listening, so the first pass happens whether or not anyone connects.
  // Without a schedule, `retention_days` was a setting a business could change that deleted
  // nothing — a promise about their customers' personal data that the product did not keep.
  const stopRetention = startRetentionSchedule({
    db,
    log,
    logError: (message, cause) => console.error(message, cause),
  })

  const server = createServer({ db, provider: resolved.provider, env: args.env })
  await new Promise<void>((resolve) => server.listen(config.port, () => resolve()))

  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : config.port
  log(`listening on http://localhost:${port}`)
  log(`admin panel: http://localhost:${port}/panel`)

  // The panel is useless without this, and the failure is invisible until someone opens it and
  // every request answers 503. Saying so at start-up — with a token ready to paste — turns a
  // confusing dead panel into a one-line fix. A token is NOT generated and used automatically:
  // it would differ on every restart, so anyone who signed in would be locked out by the next
  // one, and the process would be quietly protecting nothing an operator knows about.
  if (!args.env.QUIDCHAT_ADMIN_TOKEN) {
    log("")
    log("The admin API is refusing every request because QUIDCHAT_ADMIN_TOKEN is not set.")
    log("Set it and restart. Here is one you can use:")
    log(`  export QUIDCHAT_ADMIN_TOKEN=${randomBytes(24).toString("base64url")}`)
    log("")
  }

  return {
    port,
    close: () => {
      // Stopped on close so a test that starts several servers does not leave timers behind
      // firing against a database its own test already tore down.
      stopRetention()
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}

/**
 * Turns an empty resolution into a message that names the fix.
 *
 * "No provider configured" would be true and useless. Listing the variables that were
 * checked turns a support conversation into a single line of shell.
 */
function explainNoProvider(resolved: ResolveResult): string {
  const checked = resolved.trace.map((t) => `  ${t.envVar} (${t.preset})`).join("\n")
  const embedNote =
    resolved.chosen.chat !== null && resolved.chosen.embed === null
      ? `\n\n${resolved.chosen.chat} was found, but it has no embeddings endpoint and ` +
        "retrieval needs one. Set a key for a provider that does — OPENAI_API_KEY is " +
        "the usual pairing — and chat will stay on " +
        `${resolved.chosen.chat}.`
      : ""

  return (
    "No usable AI provider found in the environment.\n\n" +
    `Set one of these and start again:\n${checked}${embedNote}`
  )
}
