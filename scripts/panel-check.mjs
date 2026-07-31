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

/** Radix opens a menu on `pointerdown`; a plain `.click()` leaves it shut. */
const pointerClick = (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return "no element"
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }))
  }
  return "clicked"
})()`)

const menuItems = () => evaluate(
  `[...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim())`,
)

const clickMenuItem = (label) => evaluate(`(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')]
    .find(i => i.textContent.trim() === ${JSON.stringify(label)})
  if (!item) return "no item"
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    item.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }))
  }
  return "clicked"
})()`)

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

/**
 * Skills.
 *
 * The forms moved into dialogs and the actions into a per-row menu, so this drives the screen the
 * way a person now does: open the dialog, fill it, save, then act on the row that appears.
 *
 * `pointerClick` exists because Radix opens a dropdown on `pointerdown`, not on `click` — an
 * `element.click()` leaves the menu shut and every assertion after it failing for the wrong
 * reason.
 */
console.log("skills")
await open("Skills & routing")

await clickText("Add skill")
await sleep(700)
check(
  "the save button is disabled before a name is typed",
  (await clickText("Save")) === "disabled",
)
await typeInto("#skill-name", "Sales")
await typeInto("#skill-prompt", "Be brief and always mention delivery times.")
check("saving the dialog works", (await clickText("Save")) === "clicked")
await sleep(2000)
let text = await bodyText()
check("the new skill appears without a reload", text.includes("Sales"), text.slice(0, 160))
check(
  "it says nothing routes to the skill yet",
  text.includes("nothing points here"),
  text.slice(0, 200),
)

console.log("routing")
await pointerClick(`[aria-label="Actions for Sales"]`)
await sleep(600)
check("the row menu offers the actions", (await menuItems()).includes("Add routing rule"))
await clickMenuItem("Add routing rule")
await sleep(700)
await typeInto("#rule-pattern", "price")
check("adding a keyword rule works", (await clickText("Add rule")) === "clicked")
await sleep(2000)
text = await bodyText()
check(
  "the rule is listed with its pattern",
  text.includes("price") && text.includes("keyword"),
  text.slice(0, 200),
)

console.log("row actions")
await pointerClick(`[aria-label="Actions for Sales"]`)
await sleep(600)
await clickMenuItem("Disable")
await sleep(1800)
text = await bodyText()
// The action a skill never had: it could be created and then never switched off.
check("a skill can be switched off from its row", text.includes("off"), text.slice(0, 200))

console.log("canned answers")
await open("Canned answers")
// The form is behind a dialog now; the page is the table.
await clickText("Add answer")
await sleep(700)
await typeInto("#canned-question", "Do you deliver on Sunday?")
await typeInto("#canned-answer", "We deliver Monday to Saturday.")
check("saving an answer works", (await clickText("Add and approve")) === "clicked")
await sleep(2000)
text = await bodyText()
check("the answer is listed as live", text.includes("Do you deliver on Sunday?") && text.includes("Live"), text.slice(0, 200))

console.log("knowledge")
await open("Knowledge")
// The forms moved into one dialog with a tab per way in — pasted text, a page, a PDF.
await clickText("Add source")
await sleep(700)
await typeInto("#source-title", "Opening Hours")
await typeInto("#source-text", "We are open from nine in the morning until five in the afternoon.")
check("adding a text source works", (await clickText("Index this text")) === "clicked")
await sleep(4000)
text = await bodyText()
check("the source appears in the table", text.includes("Opening Hours"), text.slice(0, 200))

console.log("deleting")
// Destructive actions live under the row menu now, below a separator, rather than as a button
// sitting next to the safe ones where a mis-tap reaches them.
await pointerClick(`[aria-label="Actions for Opening Hours"]`)
await sleep(600)
check("the row menu offers deletion", (await menuItems()).includes("Delete"))
await clickMenuItem("Delete")
await sleep(1200)
text = await bodyText()
check(
  "the dialog names what will be deleted",
  /Delete .*(Opening Hours|Store Policy|Example)/.test(text),
  text.slice(0, 200),
)
// A confirmation that cannot be refused is not a confirmation.
check("cancelling is possible", (await clickText("Cancel")) === "clicked")

/**
 * Conversations.
 *
 * The screen could only be read. The two things an owner wants while reading are to write the
 * answer the assistant did not have — which meant retyping the question from memory on another
 * screen — and to erase a transcript a customer asked them to erase, which meant SQL.
 */
console.log("conversations")
await open("Conversations")
await sleep(1200)
text = await bodyText()
check("a transcript is shown", text.includes("warranty"), text.slice(0, 300))
check(
  "an answer can be turned into a canned answer",
  (await clickText("Write the answer for this")) === "clicked",
)
await sleep(800)
text = await bodyText()
check(
  "the question comes in already filled",
  text.includes("Write the answer for this question"),
  text.slice(0, 300),
)
check("it can be saved and used", (await clickText("Save and use it")) === "clicked")
await sleep(2000)

await pointerClick(`[aria-label^="Actions for the conversation"]`)
await sleep(600)
check("a transcript can be erased", (await menuItems()).includes("Delete transcript"))
await clickMenuItem("Delete transcript")
await sleep(1000)
text = await bodyText()
check("erasing asks first", /Delete the transcript with/.test(text), text.slice(0, 300))
check("erasing works", (await clickText("Delete it")) === "clicked")
await sleep(2000)
text = await bodyText()
check("the transcript is gone", text.includes("No conversations yet"), text.slice(0, 300))

/**
 * Channels.
 *
 * The page was eight cards with every credential box open at once — around twenty empty password
 * fields for a shop that connects one channel. The fields are behind the row's dialog now, and
 * pausing exists at all: the "Paused" badge was drawn from a flag nothing could ever set, so the
 * only way to stop answering on WhatsApp was to disconnect it and find the token again.
 */
console.log("channels")
await open("Channels")
await pointerClick(`[aria-label="Actions for Telegram"]`)
await sleep(600)
check("the row menu offers connecting", (await menuItems()).includes("Connect"))
await clickMenuItem("Connect")
await sleep(700)
text = await bodyText()
check(
  "the dialog shows the address to point the platform at",
  text.includes("/v1/channels/telegram/smoke-shop"),
  text.slice(0, 300),
)
check(
  "connecting is refused until the credentials are filled in",
  (await clickText("Connect")) === "disabled",
)
await typeInto("#telegram-botToken", "111:smoke-token")
await typeInto("#telegram-secretToken", "smoke-webhook-secret")
check("connecting works", (await clickText("Connect")) === "clicked")
await sleep(2000)
text = await bodyText()
check("the channel reads as connected", text.includes("Connected"), text.slice(0, 400))

await pointerClick(`[aria-label="Actions for Telegram"]`)
await sleep(600)
let items = await menuItems()
check("a connected channel can be paused", items.includes("Pause"), items)
await clickMenuItem("Pause")
await sleep(2000)
text = await bodyText()
check("pausing shows in the table", text.includes("Paused"), text.slice(0, 400))

await pointerClick(`[aria-label="Actions for Telegram"]`)
await sleep(600)
check("a paused channel can be resumed", (await menuItems()).includes("Resume"))
await clickMenuItem("Disconnect")
await sleep(1000)
text = await bodyText()
check("disconnecting asks first", text.includes("Disconnect Telegram?"), text.slice(0, 300))
check("disconnecting works", (await clickText("Disconnect it")) === "clicked")
await sleep(2000)
text = await bodyText()
check("the channel is not connected any more", text.includes("Not connected"), text.slice(0, 400))

/**
 * Tenants.
 *
 * The page listed businesses and let one be switched to; there was no rename and no removal, in
 * either the panel or the API. A typo in the name was permanent and a tenant made while trying the
 * product out could never be cleared away.
 *
 * Deleting is driven end to end here rather than stopped at the dialog, because the confirmation
 * is the interesting part: the delete button must stay dead until the slug is typed back.
 */
console.log("tenants")
await open("Tenants")
await clickText("Add tenant")
await sleep(700)
await typeInto("#tenant-name", "Smoke Test Shop")
await typeInto("#tenant-slug", "smoke-test-shop")
// The dialog's own button is "Add this tenant": two buttons reading "Add tenant" on one screen
// is ambiguous for a person and picks the wrong one here.
check("adding a tenant works", (await clickText("Add this tenant")) === "clicked")
await sleep(2500)
await open("Tenants")
text = await bodyText()
check("the tenant is listed", text.includes("Smoke Test Shop"), text.slice(0, 300))

await pointerClick(`[aria-label="Actions for Smoke Test Shop"]`)
await sleep(600)
items = await menuItems()
check("the row menu offers rename and delete", items.includes("Rename") && items.includes("Delete"), items)
await clickMenuItem("Rename")
await sleep(700)
await typeInto("#tenant-rename", "Smoke Test Warung")
check("renaming works", (await clickText("Save name")) === "clicked")
await sleep(2000)
text = await bodyText()
check("the new name shows without a reload", text.includes("Smoke Test Warung"), text.slice(0, 300))

await pointerClick(`[aria-label="Actions for Smoke Test Warung"]`)
await sleep(600)
await clickMenuItem("Delete")
await sleep(900)
check(
  "deleting stays disabled until the slug is typed",
  (await clickText("Delete this tenant")) === "disabled",
)
await typeInto("#tenant-confirm", "smoke-test-shop")
check("deleting works once it is", (await clickText("Delete this tenant")) === "clicked")
await sleep(2500)
await open("Tenants")
text = await bodyText()
check("the tenant is gone", !text.includes("Smoke Test Warung"), text.slice(0, 300))

console.log("")
console.log(`uncaught exceptions: ${errors.length}${errors.length ? ` — ${errors.join(" | ")}` : ""}`)
if (errors.length) failures++
console.log(failures === 0 ? "all interactions passed" : `${failures} interaction(s) failed`)
ws.close()
chrome.kill()
process.exit(failures === 0 ? 0 : 1)
