import type { WidgetConfig } from "./config.js"

/**
 * Presentation-only settings the widget will read from `tenant_settings.widget_theme`
 * (via `GET /widget-config`, see `packages/server/src/widget-config.ts`). Every field
 * here is deliberately something a color, a side, or a short label — never anything
 * that changes behaviour, since this is the one piece of tenant configuration that
 * ships to an unauthenticated endpoint and gets interpolated into CSS text.
 */
export type WidgetTheme = {
  /** The launcher, header, and outgoing-message accent colour. */
  primaryColor: string
  /** Which side of the screen the launcher and panel are docked to. */
  position: "left" | "right"
  /** Shown in the panel header and as its accessible name. */
  title: string
  /**
   * Language for the chrome the business does not write — button labels, the placeholder, the
   * progress lines. English chrome around an Indonesian answer means one assistant addressing a
   * customer in two languages. Defaults to English so nothing that exists today changes.
   */
  locale: "en" | "id"
  /** First thing a visitor reads. Empty means no greeting is shown. */
  greeting: string
  /**
   * Questions offered on the opening screen.
   *
   * An empty chat box is the reason widgets go unused: a visitor has to invent a question and
   * guess whether this thing can answer it. These default, server-side, to the business's own
   * approved canned answers — questions it already knows it gets, and that are guaranteed
   * answerable.
   */
  starters: string[]
}

/** The widget's current hardcoded look, unchanged from before this module existed —
 *  every value here is exactly what `ui.ts`'s `STYLE`/`STRINGS` used to hardcode. */
export const DEFAULT_THEME: WidgetTheme = {
  primaryColor: "#1a56db",
  position: "right",
  title: "Chat assistant",
  locale: "en",
  greeting: "",
  starters: [],
}

// Hex (3/4/6/8 digit, so shorthand and alpha forms both work) and functional rgb()/rgba().
// Deliberately strict rather than "anything CSS accepts": a `color` value here comes from
// whatever an operator typed into the admin's raw-JSON theme editor, and it is interpolated
// directly into the widget's <style> text. An unconstrained string could close the
// declaration it's placed in and add arbitrary rules to the page the widget shares a shadow
// root with — accepting only these shapes makes that impossible, because none of them can
// contain a `;`, a `}`, or a `<`.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RGB_COLOR = /^rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/

/** A small, fixed set of CSS named colours — not the full CSS Color Module list, which
 *  would cost bundle size for names no reasonable brand colour needs. Anything outside
 *  this set should just be expressed as hex, which every colour picker produces anyway. */
const NAMED_COLORS = new Set([
  "black", "white", "gray", "grey", "silver",
  "red", "orange", "yellow", "green", "teal", "blue", "navy", "indigo", "purple", "pink", "brown",
])

function isValidColor(value: unknown): value is string {
  return typeof value === "string"
    && (HEX_COLOR.test(value) || RGB_COLOR.test(value) || NAMED_COLORS.has(value.toLowerCase()))
}

/**
 * Turns whatever `GET /widget-config` returned into a theme safe to render, field by
 * field rather than all-or-nothing — a bad `position` should not also throw away a
 * perfectly good `primaryColor`. Anything missing, of the wrong shape, or failing
 * validation falls back to `DEFAULT_THEME`'s value for that one field, so the widget
 * never renders unstyled and never forwards an unvalidated string into CSS.
 */
export function sanitizeTheme(input: unknown): WidgetTheme {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
  return {
    primaryColor: isValidColor(raw.primaryColor) ? raw.primaryColor : DEFAULT_THEME.primaryColor,
    position: raw.position === "left" || raw.position === "right" ? raw.position : DEFAULT_THEME.position,
    title: typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title : DEFAULT_THEME.title,
    locale: raw.locale === "id" || raw.locale === "en" ? raw.locale : DEFAULT_THEME.locale,
    greeting: typeof raw.greeting === "string" ? raw.greeting : DEFAULT_THEME.greeting,
    // Bounded and filtered here as well as on the server: this value is rendered as text into a
    // stranger's page, and "the server already checked" is not a property this module can rely on.
    starters: Array.isArray(raw.starters)
      ? raw.starters.filter((s): s is string => typeof s === "string" && s.trim() !== "").slice(0, 4)
      : DEFAULT_THEME.starters,
  }
}

// A theme fetch that never resolves would leave a visitor with no launcher at all —
// worse than the unstyled fallback this whole module exists to avoid. Three seconds is
// long enough for a normal round trip and short enough that a hung request still lets
// the widget mount looking exactly as it always has.
const FETCH_TIMEOUT_MS = 3000

/**
 * Fetches the tenant's public widget theme and returns a fully validated
 * `WidgetTheme`, defaulting to the hardcoded look on any problem: offline, a 404
 * (unknown tenant, or a server too old to have this route at all), a malformed
 * body, a timeout, or values that fail validation. Nothing here ever throws — the
 * whole point is that a theme that can't be loaded is exactly as safe as no theme.
 */
export async function fetchWidgetTheme(cfg: WidgetConfig): Promise<WidgetTheme> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const url = `${cfg.apiBase}/v1/widget-config?tenantSlug=${encodeURIComponent(cfg.tenantSlug)}`
    const res = await fetch(url, { signal: controller.signal })
    if (res.status !== 200) return DEFAULT_THEME
    return sanitizeTheme(await res.json())
  } catch {
    return DEFAULT_THEME
  } finally {
    clearTimeout(timer)
  }
}
