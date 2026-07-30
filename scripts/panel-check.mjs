#!/usr/bin/env node
/**
 * Uses the admin panel the way an owner does: types into its forms, clicks its buttons, and
 * checks the result appears.
 *
 * The contract tests cover the API client, and the unit tests cover components in isolation.
 * Neither exercises the form wiring — the change handlers, the disabled conditions, the reload
 * after a mutation — and a panel where every button is dead would pass both.
 *
 * Usage, against a server you already have running with a tenant on it:
 *
 *   node scripts/panel-check.mjs http://localhost:3210 <admin-token>
 *
 * It needs a Chromium or Chrome binary. Set CHROME_PATH, or let it find one of the usual
 * locations. With no browser it SKIPS rather than fails: not having one is a missing tool, not a
 * broken panel, and a check that fails for the wrong reason gets ignored for the right ones.
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

function findBrowser() {
  // An explicitly configured path that does not exist is a mistake worth reporting, not a
  // reason to quietly use a different browser than the one someone asked for.
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
    console.error(`CHROME_PATH is set to ${process.env.CHROME_PATH}, which does not exist`)
    process.exit(2)
  }
  const candidates = [
    `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean)
  return candidates.find((path) => existsSync(path)) ?? null
}

const CHROME = findBrowser()
if (!CHROME) {
  console.log("no Chrome or Chromium found — skipping the panel check")
  console.log("set CHROME_PATH to run it")
  process.exit(0)
}

const BASE = process.argv[2]
if (!BASE) {
  console.error("usage: node scripts/panel-check.mjs <base-url> [admin-token]")
  process.exit(2)
}
const TOKEN = process.argv[3] ?? process.env.QUIDCHAT_ADMIN_TOKEN ?? "t0ken"
const PORT = 9444

const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,900", "about:blank",
], { stdio: "ignore" })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
  if (!ok) failures++
}

let url
for (let i = 0; i < 40; i++) {
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    url = list.find((t) => t.type === "page")?.webSocketDebuggerUrl
    if (url) break
  } catch {}
  await sleep(250)
}

const ws = new WebSocket(url)
await new Promise((r) => ws.addEventListener("open", r))
let id = 0
const pending = new Map()
const errors = []
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text)
})
const send = (method, params = {}) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, params }))
  return new Promise((r) => pending.set(i, r))
}
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value

await send("Page.enable")
await send("Runtime.enable")
await send("Page.navigate", { url: `${BASE}/panel` })
await sleep(1500)
await evaluate(`sessionStorage.setItem("quidchat-admin-token", ${JSON.stringify(TOKEN)})`)

async function open(section) {
  await send("Page.navigate", { url: `${BASE}/panel` })
  await sleep(1800)
  await evaluate(`[...document.querySelectorAll("button,a")].find(e=>e.textContent.trim()===${JSON.stringify(section)})?.click()`)
  await sleep(1500)
}

/** React tracks input state internally, so setting `.value` is ignored. The native setter plus a
 *  bubbled input event is what a real keystroke looks like to it. */
const typeInto = (selector, text) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return "no element"
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event("input", { bubbles: true }))
  return "typed"
})()`)

const clickText = (text) => evaluate(`(() => {
  const el = [...document.querySelectorAll("button")].find(e => e.textContent.trim() === ${JSON.stringify(text)})
  if (!el) return "not found"
  if (el.disabled) return "disabled"
  el.click()
  return "clicked"
})()`)

const bodyText = () => evaluate(`document.body.innerText`)

console.log("skills")
await open("Skills & routing")
check("the add button is disabled before a name is typed", (await clickText("Add skill")) === "disabled")
await typeInto("#skill-name", "Sales")
await typeInto("#skill-prompt", "Be brief and always mention delivery times.")
check("submitting the form works", (await clickText("Add skill")) === "clicked")
await sleep(2000)
let text = await bodyText()
check("the new skill appears without a reload", text.includes("Sales"), text.slice(0, 160))
check("it says the skill is unreachable until a rule points at it", text.includes("No rule points here"))

console.log("routing")
await typeInto("input[aria-label='Keyword']", "price")
check("adding a keyword rule works", (await clickText("Add rule")) === "clicked")
await sleep(2000)
text = await bodyText()
check("the rule is listed with its pattern", text.includes("price") && text.includes("keyword"), text.slice(0, 200))

console.log("canned answers")
await open("Canned answers")
await typeInto("#canned-question", "Do you deliver on Sunday?")
await typeInto("#canned-answer", "We deliver Monday to Saturday.")
check("saving an answer works", (await clickText("Add and approve")) === "clicked")
await sleep(2000)
text = await bodyText()
check("the answer is listed as live", text.includes("Do you deliver on Sunday?") && text.includes("Live"), text.slice(0, 200))

console.log("knowledge")
await open("Knowledge")
await typeInto("#source-title", "Opening Hours")
await typeInto("#source-text", "We are open from nine in the morning until five in the afternoon.")
check("adding a text source works", (await clickText("Add source")) === "clicked")
await sleep(4000)
text = await bodyText()
check("the source appears in the table", text.includes("Opening Hours"), text.slice(0, 200))

console.log("deleting")
check("the delete button opens a confirmation", (await clickText("Delete")) === "clicked")
await sleep(1200)
text = await bodyText()
check("the dialog names what will be deleted", /Delete .*(Opening Hours|Store Policy|Example)/.test(text), text.slice(0, 200))
check("cancelling is possible", (await clickText("Keep it")) === "clicked")

console.log("")
console.log(`uncaught exceptions: ${errors.length}${errors.length ? ` — ${errors.join(" | ")}` : ""}`)
if (errors.length) failures++
console.log(failures === 0 ? "all interactions passed" : `${failures} interaction(s) failed`)
ws.close()
chrome.kill()
process.exit(failures === 0 ? 0 : 1)
