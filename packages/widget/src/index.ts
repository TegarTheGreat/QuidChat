import { readConfig } from "./config.js"
import { fetchWidgetTheme } from "./theme.js"
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

// `fetchWidgetTheme` never throws and never returns nothing — offline, an unknown
// tenant, or a server too old to have the route all resolve to `DEFAULT_THEME` —
// so there is no failure path here to handle beyond letting it resolve.
async function init(): Promise<void> {
  const theme = await fetchWidgetTheme(config)
  const container = document.createElement("div")
  document.body.appendChild(container)
  mountWidget(container, config, undefined, theme)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init())
} else {
  void init()
}
