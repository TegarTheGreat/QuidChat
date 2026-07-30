import { readConfig } from "./config.js"
import { mountWidget } from "./ui.js"

/** `document.currentScript` is only reliable while this module's top-level code is
 *  still running — exactly where this is called from — not from inside a later
 *  callback, which is why this runs synchronously at load rather than deferred. */
function currentScript(): HTMLScriptElement {
  const script = document.currentScript
  if (!(script instanceof HTMLScriptElement)) {
    throw new Error("QuidChat widget: expected to be loaded via a <script> tag.")
  }
  return script
}

// Captured synchronously, at module top level: `document.currentScript` is only
// reliable while this script's own top-level code is running. Reading it later,
// inside a deferred `DOMContentLoaded` callback, would see `null` instead.
const script = currentScript()
const config = readConfig(script)

function init(): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  mountWidget(container, config)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init)
} else {
  init()
}
