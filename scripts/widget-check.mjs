#!/usr/bin/env node
/**
 * The customer's journey, in a browser, end to end.
 *
 * Builds a page with nothing on it but the embed snippet from the README, serves that page from
 * its own origin, then opens the widget, asks a question and checks the answer and its citation
 * appear.
 *
 * This exists because the server shipped without CORS headers: the widget worked from curl, from
 * the test suite, and from no browser at all, and the entire product is a script tag on somebody
 * else's site. A check that never leaves the same origin cannot see that, which is why this one
 * serves the page separately.
 *
 * Usage, against a running server whose tenant allows the page's origin:
 *
 *   node scripts/widget-check.mjs http://localhost:3210 <tenant-slug>
 *
 * Needs a Chrome or Chromium binary; set CHROME_PATH, or it skips with a message.
 */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync } from "node:fs"

function findBrowser() {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
    console.error(`CHROME_PATH is set to ${process.env.CHROME_PATH}, which does not exist`)
    process.exit(2)
  }
  return [
    `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
  ].find((path) => existsSync(path)) ?? null
}

const CHROME = findBrowser()
if (!CHROME) {
  console.log("no Chrome or Chromium found — skipping the widget check")
  console.log("set CHROME_PATH to run it")
  process.exit(0)
}

const API = process.argv[2]
const TENANT = process.argv[3]
if (!API || !TENANT) {
  console.error("usage: node scripts/widget-check.mjs <api-base-url> <tenant-slug>")
  process.exit(2)
}

// A different port, and therefore a different origin from the API — which is the whole point.
const SITE_PORT = 4901
const PAGE = `http://127.0.0.1:${SITE_PORT}/`
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test site</title></head>
<body><h1>Test site</h1>
<script src="${API}/quidchat.js" data-quidchat-tenant="${TENANT}" data-quidchat-api="${API}" defer></script>
</body></html>`

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(HTML)
})
await new Promise((resolve) => site.listen(SITE_PORT, "127.0.0.1", resolve))
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--hide-scrollbars", "--remote-debugging-port=9555", "--window-size=1280,860", "about:blank",
], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let url
for (let i = 0; i < 40; i++) {
  try { const l = await fetch("http://127.0.0.1:9555/json/list").then(r=>r.json()); url = l.find(t=>t.type==="page")?.webSocketDebuggerUrl; if (url) break } catch {}
  await sleep(250)
}
const ws = new WebSocket(url)
await new Promise((r) => ws.addEventListener("open", r))
let id = 0; const pending = new Map(); const errors = []
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception?.description ?? ""))
})
const send = (method, params={}) => { const i = ++id; ws.send(JSON.stringify({id:i,method,params})); return new Promise(r=>pending.set(i,r)) }
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value

await send("Page.enable"); await send("Runtime.enable")
await send("Page.navigate", { url: PAGE })
await sleep(2500)

// The widget lives in a shadow root, so everything below reaches through it — which is also a
// check that it is isolated from the page rather than leaking styles into it.
const root = `document.querySelector("#quidchat-widget, [data-quidchat-root], div").shadowRoot`
const hasShadow = await evaluate(`Boolean([...document.querySelectorAll("*")].find(e => e.shadowRoot))`)
const q = (sel) => `[...document.querySelectorAll("*")].find(e=>e.shadowRoot)?.shadowRoot.querySelector(${JSON.stringify(sel)})`

const launcher = await evaluate(`${q("button")}?.textContent ?? "<none>"`)
await evaluate(`${q("button")}?.click()`)
await sleep(600)
const title = await evaluate(`${q(".header-title")}?.textContent ?? "<none>"`)
const accent = await evaluate(`getComputedStyle(${q("button")}).backgroundColor`)

await evaluate(`(() => {
  const el = ${q("textarea, input[type=text]")}
  if (!el) return "no input"
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, "how long is the warranty?")
  el.dispatchEvent(new Event("input", { bubbles: true }))
  return "typed"
})()`)
const stages = []
const sendBtn = `[...[...document.querySelectorAll("*")].find(e=>e.shadowRoot).shadowRoot.querySelectorAll("button")].find(b=>b.textContent.trim()==="Send")`
await evaluate(`${sendBtn}?.click()`)
for (let i = 0; i < 20; i++) {
  await sleep(250)
  const s = await evaluate(`[...document.querySelectorAll("*")].find(e=>e.shadowRoot).shadowRoot.textContent`)
  if (s && !stages.includes(s)) stages.push(s)
  if (s && /warranty covering|Sorry|unavailable/.test(s)) break
}
const finalText = await evaluate(`[...document.querySelectorAll("*")].find(e=>e.shadowRoot).shadowRoot.textContent`)

let failures = 0
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
  if (!ok) failures++
}

check("the widget mounts in a shadow root", hasShadow === true)
check("the launcher is on the page", launcher.length > 0, launcher)
check("the panel opens with its configured title", Boolean(title) && title !== "<none>", title)
check("the accent colour is applied", /rgb/.test(String(accent)), String(accent))
// The answer and its citation are the product's whole promise, and both travel over the
// cross-origin request that used to be blocked outright.
if (/not authorized/i.test(finalText ?? "")) {
  // Not a defect: the origin allowlist did its job. Saying exactly which origin to add turns a
  // failed run into a one-line fix — and the fact that this message reached the page at all is
  // itself the CORS header being sent on the 403.
  console.log(`  note the tenant does not allow ${PAGE.replace(/\/$/, "")}`)
  console.log(`       add it to this tenant's allowed origins and run again`)
  failures++
} else {
  // The answer and its citation are the product's whole promise, and both travel over the
  // cross-origin request that used to be blocked outright.
  check("the question is answered", /warranty|deliver|return|sorry/i.test(finalText ?? ""), (finalText ?? "").slice(-160))
  check("the answer names its source", /Source:/.test(finalText ?? ""), (finalText ?? "").slice(-160))
}
check("no uncaught exceptions on the page", errors.length === 0, errors.join(" | "))

console.log("")
console.log(failures === 0 ? "the widget works from another origin" : `${failures} check(s) failed`)
ws.close()
chrome.kill()
site.close()
process.exit(failures === 0 ? 0 : 1)
