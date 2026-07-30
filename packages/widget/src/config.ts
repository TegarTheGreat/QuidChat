/** Everything the widget needs to talk to one tenant's assistant. */
export type WidgetConfig = {
  tenantSlug: string
  /** Origin the API lives on, no trailing slash — e.g. `https://api.quidchat.example`. */
  apiBase: string
}

/** Strips exactly one trailing slash, so `https://api.example` and
 *  `https://api.example/` produce the same `apiBase`. */
function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

/**
 * Reads the widget's configuration off the `<script>` tag that loaded it.
 *
 * `data-quidchat-tenant` is required: a widget with no tenant has nothing to talk
 * to, and rendering one anyway just teaches a visitor that the assistant is broken.
 * Failing loudly here, at load, is cheaper than a support ticket about a widget that
 * "does nothing."
 *
 * `data-quidchat-api` is optional and defaults to the origin the script itself was
 * served from — the common case is one host serving both the page and the API, so
 * the single-attribute embed (`data-quidchat-tenant` only) should just work.
 */
export function readConfig(script: HTMLScriptElement): WidgetConfig {
  const tenantSlug = script.getAttribute("data-quidchat-tenant")
  if (tenantSlug === null || tenantSlug.length === 0) {
    throw new Error(
      "QuidChat widget: missing required `data-quidchat-tenant` attribute on the <script> tag.",
    )
  }

  const explicitApi = script.getAttribute("data-quidchat-api")
  const apiBase = explicitApi !== null && explicitApi.length > 0
    ? explicitApi
    : new URL(script.src).origin

  return { tenantSlug, apiBase: trimTrailingSlash(apiBase) }
}
