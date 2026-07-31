#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { runAddText } from "./add-text.js"
import { runAddPdf } from "./add-pdf.js"
import { runAddSite } from "./add-site.js"
import { runBackup } from "./backup.js"
import { runAddUrl } from "./add-url.js"
import { runInit } from "./init.js"
import { runPrune } from "./prune.js"
import { serve } from "./serve.js"

/**
 * The `quidchat` binary.
 *
 * Deliberately thin: every command's logic lives in a function that takes its
 * environment as an argument. This file is the only place in the codebase that reads
 * `process.env` or `process.argv`, or calls `process.exit`, which is what keeps every
 * layer beneath it testable without touching real process state.
 */

const USAGE = `Usage:
  quidchat serve
      Start the server. Reads PORT, DATABASE_URL or QUIDCHAT_DATA_DIR, and a
      provider key from the environment.

  quidchat init <slug> --name "<display name>" --origin <url> [--origin <url>]
      Create or update a tenant. At least one origin is required — the widget is
      refused on any site not listed.

  quidchat add-text <slug> --title "<title>" (--file <path> | --stdin)
      Index text as a knowledge source for a tenant.

  quidchat add-site <slug> <url> [--max-pages <n>]
      Read a whole site and index every page. Follows the site's own links, stays
      on its origin, obeys robots.txt, and stops at --max-pages (default 25).
      Give it a sitemap.xml and it reads exactly what the sitemap lists.

  quidchat add-pdf <slug> <file.pdf> [--title "<title>"]
      Index a PDF. A scan with no text in it is refused with a reason rather
      than indexed as nothing.

  quidchat backup [--out <path>]
      Write one file containing everything: documents, canned answers,
      conversations. Taken through the running engine, so it is a snapshot
      rather than a copy of files being written to. On a managed Postgres it
      prints the pg_dump command instead of pretending.

  quidchat prune
      Delete conversations past each tenant's retention window, then exit. The
      server does this daily on its own; this is for running it from cron.

  quidchat add-url <slug> <url> [--title "<title>"]
      Read a page and index it. Private and local addresses are refused, including
      via a redirect. Without --title, the page's own title is used.
`

/** Collects repeated flags, so `--origin a --origin b` yields both. */
function parseFlags(argv: string[]): {
  positional: string[]
  named: Map<string, string[]>
} {
  const positional: string[] = []
  const named = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    // A boolean flag has no value after it, so the next token counts as a value only
    // when it is not itself a flag. Otherwise `--stdin --title x` would swallow --title.
    const next = argv[i + 1]
    let value = ""
    if (next !== undefined && !next.startsWith("--")) {
      value = next
      i++
    }
    named.set(key, [...(named.get(key) ?? []), value])
  }
  return { positional, named }
}

function firstOf(named: Map<string, string[]>, key: string): string | undefined {
  return named.get(key)?.[0]
}

/**
 * Ends a one-shot command.
 *
 * The work being finished does not make the process exit: an embedded PGlite instance and the
 * HTTP client's connection pool both keep handles open, and `add-text` was observed printing
 * its success line and then hanging indefinitely — a user sees the work succeed and still has
 * to interrupt the terminal, which reads as a failure of the thing that just told them it
 * worked. Commands that have produced their output are done, and a CLI should not depend on
 * every library releasing every handle to say so.
 *
 * stdout is flushed first. `process.exit` does not wait for a pipe to drain, and the same
 * success line that made this bug visible was lost that way while diagnosing it.
 */
async function finish(): Promise<never> {
  await new Promise<void>((resolve) => {
    // `write` calls back once the data is handed to the OS. An empty write is enough: the
    // callback still fires after everything queued before it.
    if (!process.stdout.write("", () => resolve())) process.stdout.once("drain", () => resolve())
  })
  process.exit(0)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, named } = parseFlags(rest)

  if (command === undefined || command === "serve") {
    const running = await serve({ env: process.env })

    // A container runtime sends SIGTERM and waits a few seconds before SIGKILL. Without a
    // handler Node exits at once: a request being answered is dropped mid-write, and on the
    // embedded tier PGlite's last writes may never reach disk — a customer's question answered
    // and then forgotten. Draining first costs a second and makes a redeploy invisible to
    // whoever is mid-conversation.
    //
    // Registered AFTER a successful start, so a process that failed to start still exits the
    // ordinary way rather than sitting in a handler with nothing to drain.
    let shuttingDown = false
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (shuttingDown) {
          // A second signal means someone is impatient, and the honest response is to go now
          // rather than to appear hung while a slow request finishes.
          process.exit(130)
        }
        shuttingDown = true
        console.log(`\n${signal} received, finishing in-flight requests…`)
        running
          .close()
          .then(() => process.exit(0))
          .catch((cause: unknown) => {
            console.error("shutdown failed", cause)
            process.exit(1)
          })
      })
    }
    return
  }

  if (command === "init") {
    const slug = positional[0]
    if (!slug) throw new Error(`a tenant slug is required\n\n${USAGE}`)
    await runInit({
      env: process.env,
      slug,
      name: firstOf(named, "name") ?? slug,
      origins: (named.get("origin") ?? []).filter((o) => o.length > 0),
    })
    await finish()
  }

  if (command === "add-text") {
    const slug = positional[0]
    if (!slug) throw new Error(`a tenant slug is required\n\n${USAGE}`)
    const title = firstOf(named, "title")
    if (!title) throw new Error(`--title is required\n\n${USAGE}`)

    const file = firstOf(named, "file")
    const useStdin = named.has("stdin")
    if (!file && !useStdin) throw new Error(`--file or --stdin is required\n\n${USAGE}`)

    // Reading fd 0 rather than a path lets content be piped in, which is how anyone
    // scripting this will want to use it.
    const text = useStdin ? readFileSync(0, "utf8") : readFileSync(file!, "utf8")

    await runAddText({ env: process.env, slug, title, text })
    await finish()
  }

  if (command === "prune") {
    await runPrune({ env: process.env })
    await finish()
  }

  if (command === "add-pdf") {
    const slug = positional[0]
    if (!slug) throw new Error(`a tenant slug is required\n\n${USAGE}`)
    const path = positional[1]
    if (!path) throw new Error(`a path to a PDF is required\n\n${USAGE}`)
    const title = firstOf(named, "title")
    await runAddPdf({ env: process.env, slug, path, ...(title ? { title } : {}) })
    await finish()
  }

  if (command === "backup") {
    const out = firstOf(named, "out")
    await runBackup({ env: process.env, ...(out ? { out } : {}) })
    await finish()
  }

  if (command === "add-site") {
    const slug = positional[0]
    if (!slug) throw new Error(`a tenant slug is required\n\n${USAGE}`)
    const url = positional[1]
    if (!url) throw new Error(`a URL is required\n\n${USAGE}`)
    const maxPages = Number(firstOf(named, "max-pages") ?? "")
    await runAddSite({
      env: process.env,
      slug,
      url,
      ...(Number.isFinite(maxPages) && maxPages > 0 ? { maxPages } : {}),
    })
    await finish()
  }

  if (command === "add-url") {
    const slug = positional[0]
    if (!slug) throw new Error(`a tenant slug is required\n\n${USAGE}`)
    const url = positional[1]
    if (!url) throw new Error(`a URL is required\n\n${USAGE}`)
    const title = firstOf(named, "title")
    await runAddUrl({ env: process.env, slug, url, ...(title ? { title } : {}) })
    await finish()
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`)
}

try {
  await main()
} catch (e) {
  // The message is the product here. Every command throws with the flag or environment
  // variable that would fix it, so printing the message alone is more useful to an
  // operator than a stack trace pointing at our own code.
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
