import { afterEach, describe, expect, it, vi } from "vitest"
import type { WidgetConfig } from "./config.js"
import { DEFAULT_THEME, fetchWidgetTheme, sanitizeTheme } from "./theme.js"

const cfg: WidgetConfig = { tenantSlug: "acme", apiBase: "https://api.example.test" }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("sanitizeTheme", () => {
  it("accepts a hex colour, an rgb() colour, and a fixed named colour", () => {
    expect(sanitizeTheme({ primaryColor: "#ff0000" }).primaryColor).toBe("#ff0000")
    expect(sanitizeTheme({ primaryColor: "rgb(10, 20, 30)" }).primaryColor).toBe("rgb(10, 20, 30)")
    expect(sanitizeTheme({ primaryColor: "teal" }).primaryColor).toBe("teal")
  })

  it("falls back to the default colour for anything that could break out of a CSS declaration", () => {
    // Each of these is a plausible value for a hostile or merely careless operator to
    // type into the admin's raw-JSON theme editor. None may reach the widget's <style>
    // text unchanged.
    for (const hostile of [
      "red; } .evil { position: fixed; top: 0",
      "url(javascript:alert(1))",
      "</style><script>alert(1)</script>",
      "not-a-real-colour",
      "",
    ]) {
      expect(sanitizeTheme({ primaryColor: hostile }).primaryColor, hostile).toBe(DEFAULT_THEME.primaryColor)
    }
  })

  it("falls back field by field: an invalid position does not discard a valid colour or title", () => {
    expect(sanitizeTheme({ primaryColor: "#00ff00", position: "sideways", title: "Acme Support" })).toEqual({
      primaryColor: "#00ff00",
      position: DEFAULT_THEME.position,
      title: "Acme Support",
      locale: "en",
      greeting: "",
      starters: [],
    })
  })

  it("falls back to the default title when it is missing or blank", () => {
    expect(sanitizeTheme({}).title).toBe(DEFAULT_THEME.title)
    expect(sanitizeTheme({ title: "   " }).title).toBe(DEFAULT_THEME.title)
  })
})

describe("fetchWidgetTheme", () => {
  it("falls back to the default theme when the request fails outright, e.g. offline", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))))
    expect(await fetchWidgetTheme(cfg)).toEqual(DEFAULT_THEME)
  })

  it("falls back to the default theme on a non-200, e.g. an unknown tenant or a server too old to have the route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })))
    expect(await fetchWidgetTheme(cfg)).toEqual(DEFAULT_THEME)
  })

  it("returns the sanitized theme from a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ primaryColor: "#123456", position: "left", title: "Acme" }), { status: 200 }),
      ),
    )
    expect(await fetchWidgetTheme(cfg)).toEqual({
      primaryColor: "#123456",
      position: "left",
      title: "Acme",
      locale: "en",
      greeting: "",
      starters: [],
    })
  })
})

describe("locale", () => {
  it("takes a language the tenant chose, and ignores anything else", () => {
    // The chrome follows the answers. An Indonesian shop whose assistant replies in Indonesian
    // should not be sending its customers a button that says "Send".
    expect(sanitizeTheme({ locale: "id" }).locale).toBe("id")
    expect(sanitizeTheme({ locale: "en" }).locale).toBe("en")
    for (const bad of ["fr", "", 7, null, undefined, {}]) {
      expect(sanitizeTheme({ locale: bad }).locale, String(bad)).toBe("en")
    }
  })
})

describe("opening questions", () => {
  it("keeps the ones a business supplied, bounded", () => {
    // Past four, a panel meant to remove hesitation becomes a menu to read.
    const many = ["a", "b", "c", "d", "e", "f"]
    expect(sanitizeTheme({ starters: many }).starters).toEqual(["a", "b", "c", "d"])
  })

  it("drops anything that is not a question a visitor could tap", () => {
    // This value is rendered as text into a stranger's page. "The server already checked" is not
    // a property this module can rely on — it is reachable by anything that can answer the
    // config request.
    expect(sanitizeTheme({ starters: ["ok", "", "   ", 7, null, {}] }).starters).toEqual(["ok"])
    expect(sanitizeTheme({ starters: "not an array" }).starters).toEqual([])
    expect(sanitizeTheme({}).starters).toEqual([])
  })

  it("takes a greeting only when it is text", () => {
    expect(sanitizeTheme({ greeting: "Halo!" }).greeting).toBe("Halo!")
    expect(sanitizeTheme({ greeting: 12 }).greeting).toBe("")
  })
})
