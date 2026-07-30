#!/usr/bin/env node
import { serve } from "./serve.js"

/**
 * The `quidchat` binary.
 *
 * Deliberately thin: everything it does lives in `serve()`, which takes its environment
 * as an argument. This file is the only place in the codebase that reads `process.env`
 * or calls `process.exit`, which is what keeps every layer beneath it testable.
 */
const command = process.argv[2] ?? "serve"

if (command === "serve") {
  try {
    await serve({ env: process.env })
  } catch (e) {
    // The message is the product here. `serve` throws with the environment variables it
    // looked for, so printing the message alone is more useful to an operator than a
    // stack trace pointing at our own code.
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
} else {
  console.error(`Unknown command: ${command}\n\nUsage: quidchat serve`)
  process.exit(1)
}
