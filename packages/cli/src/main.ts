#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { runAddText } from "./add-text.js"
import { runInit } from "./init.js"
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, named } = parseFlags(rest)

  if (command === undefined || command === "serve") {
    await serve({ env: process.env })
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
    return
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
    return
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
