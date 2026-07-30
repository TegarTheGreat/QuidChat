#!/usr/bin/env node
/**
 * Runs the built binary the way a person does.
 *
 * The unit suite covers behaviour; this covers the artifact. Every defect it was written after
 * was invisible to the suite and obvious within a minute of using the thing: a `bin` pointing at
 * a TypeScript file, migrations resolved relative to a module that no longer existed after
 * bundling, a data directory whose parent was never created, and — the reason this file exists —
 * `add-text` printing its success line and then never exiting, because the work finishing does
 * not make a process end.
 *
 * It talks to a local OpenAI-compatible server rather than a real provider, so it costs nothing,
 * needs no key and no network, and still exercises the real HTTP client, real embeddings, real
 * retrieval and the real grounding validator. That also makes it a live test of
 * `OPENAI_BASE_URL`, which every self-hosted and gateway deployment depends on.
 *
 * Run it after `pnpm build`:
 *
 *   node scripts/smoke.mjs
 *
 * It exits non-zero on the first failure, with the step that failed named.
 */

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = new URL("../packages/cli/dist/main.mjs", import.meta.url).pathname
const PROVIDER_PORT = 4711
const SERVER_PORT = 4712
const ORIGIN = "https://smoke.example"

const POLICY = [
  "Returns are accepted within seven days of purchase, with the receipt.",
  "",
  "Every unit carries a one-year warranty covering manufacturing defects.",
].join("\n")

let failures = 0

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`)
  }
}

/**
 * A deterministic stand-in for OpenAI.
 *
 * Embeddings hash words into a fixed-width vector, so texts sharing words land near each other
 * and retrieval has something real to rank rather than a constant. The chat completion quotes
 * the first context chunk and cites its id, which is what a grounded answer looks like on the
 * wire — enough for the validator to accept or reject it for the right reasons.
 */
function startProvider() {
  const embed = (text) => {
    const v = new Array(1536).fill(0)
    for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 1536
      v[h] += 1
    }
    const norm = Math.hypot(...v) || 1
    return v.map((x) => x / norm)
  }

  const read = (req) =>
    new Promise((resolve) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => resolve(body))
    })

  const server = createServer(async (req, res) => {
    const raw = await read(req)
    res.setHeader("content-type", "application/json")
    let body
    try {
      body = JSON.parse(raw || "{}")
    } catch {
      res.writeHead(400).end("{}")
      return
    }

    if (req.url.includes("/embeddings")) {
      const input = Array.isArray(body.input) ? body.input : [body.input]
      res.end(
        JSON.stringify({
          data: input.map((text, index) => ({ index, embedding: embed(text) })),
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      )
      return
    }

    const prompt = (body.messages ?? []).map((m) => m.content).join("\n")
    const cited = /\[([0-9a-f-]{36})\] \(([^)]*)\)\n([^\n]+)/.exec(prompt)
    const answer = cited
      ? { segments: [{ text: cited[3], kind: "business_claim", citations: [cited[1]] }] }
      : { segments: [{ text: "I do not have that information yet.", kind: "general" }] }
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }),
    )
  })

  return new Promise((resolve) => server.listen(PROVIDER_PORT, "127.0.0.1", () => resolve(server)))
}

/**
 * Runs a CLI command to completion.
 *
 * The timeout is the point of this helper, not a precaution: a command that finishes its work
 * and never exits is the exact failure this script was written for, and without a bound it would
 * hang here instead of reporting.
 */
function runCli(args, env, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false })
    })
  })
}

async function waitForHealth(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return true
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function main() {
  const provider = await startProvider()
  const dir = await mkdtemp(join(tmpdir(), "quidchat-smoke-"))
  const policyPath = join(dir, "policy.txt")
  await writeFile(policyPath, POLICY, "utf8")

  const env = {
    QUIDCHAT_DATA_DIR: join(dir, "data"),
    QUIDCHAT_ADMIN_TOKEN: "smoke-token",
    OPENAI_API_KEY: "sk-smoke",
    OPENAI_BASE_URL: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
    PORT: String(SERVER_PORT),
  }

  let server
  try {
    console.log("init")
    const init = await runCli(["init", "smoke-shop", "--name", "Smoke Shop", "--origin", ORIGIN], env)
    check("init exits", init.code === 0 && !init.timedOut, init.stderr.trim() || `code ${init.code}`)
    check("init reports the tenant", init.stdout.includes("smoke-shop"))

    console.log("add-text")
    const add = await runCli(
      ["add-text", "smoke-shop", "--title", "Store Policy", "--file", policyPath],
      env,
    )
    // Both halves matter. The command has succeeded at its job and still hung here before.
    check("add-text exits", add.code === 0 && !add.timedOut, add.timedOut ? "timed out" : add.stderr.trim())
    check("add-text reports what it indexed", /indexed .* chunk/.test(add.stdout), add.stdout.trim())

    console.log("serve")
    server = spawn(process.execPath, [CLI, "serve"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let serverLog = ""
    server.stdout.on("data", (c) => (serverLog += c))
    server.stderr.on("data", (c) => (serverLog += c))

    const base = `http://127.0.0.1:${SERVER_PORT}`
    check("server becomes healthy", await waitForHealth(base), serverLog.trim())
    check("server names the panel", serverLog.includes("/panel"))

    const panel = await fetch(`${base}/panel`)
    check("panel is served", panel.status === 200 && (await panel.text()).includes("<div"))

    const widget = await fetch(`${base}/quidchat.js`)
    check("widget bundle is served", widget.status === 200 && (await widget.text()).length > 1000)

    const answer = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ tenantSlug: "smoke-shop", message: "warranty" }),
    }).then((r) => r.json())
    check("a question is answered", answer.kind === "answered", JSON.stringify(answer).slice(0, 200))
    check(
      "the answer cites the document by name",
      answer.citations?.[0]?.documentTitle === "Store Policy",
      JSON.stringify(answer.citations),
    )

    const forbidden = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://not-allowed.example" },
      body: JSON.stringify({ tenantSlug: "smoke-shop", message: "warranty" }),
    })
    // The origin allowlist is the only thing between a business's assistant and anyone who
    // copies its public slug, so a smoke test that never checks it is missing the point.
    check("an unlisted origin is refused", forbidden.status === 403)

    const admin = await fetch(`${base}/v1/admin/sources?tenantSlug=smoke-shop`, {
      headers: { authorization: "Bearer smoke-token" },
    }).then((r) => r.json())
    check("the admin API lists the source by title", admin.sources?.[0]?.title === "Store Policy")

    const unauthorized = await fetch(`${base}/v1/admin/sources?tenantSlug=smoke-shop`)
    check("the admin API refuses a missing token", unauthorized.status === 401)

    console.log("shutdown")
    const exited = new Promise((resolve) => server.on("close", (code) => resolve(code)))
    server.kill("SIGTERM")
    const code = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r("timeout"), 15_000)),
    ])
    check("SIGTERM shuts the server down", code === 0, String(code))
    server = undefined
  } finally {
    if (server) server.kill("SIGKILL")
    provider.close()
    await rm(dir, { recursive: true, force: true })
  }

  console.log("")
  if (failures > 0) {
    console.log(`${failures} check(s) failed`)
    process.exit(1)
  }
  console.log("all checks passed")
  process.exit(0)
}

await main()
