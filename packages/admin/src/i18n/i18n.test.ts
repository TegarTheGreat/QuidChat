import { describe, expect, it } from "vitest"
import { en } from "./en.js"
import { es } from "./es.js"
import { hi } from "./hi.js"
import { id } from "./id.js"
import { ja } from "./ja.js"
import { ko } from "./ko.js"
import { ms } from "./ms.js"
import { pt } from "./pt.js"
import { ru } from "./ru.js"
import { zh } from "./zh.js"
import { isLocale, LOCALES, LOCALE_NAMES, readLocale } from "./index.js"

/** Every dictionary but the English one, which is the thing they are all checked against. */
const TRANSLATIONS = { id, ms, zh, hi, es, pt, ru, ja, ko } as const

/**
 * The dictionaries, checked against each other.
 *
 * TypeScript already refuses a missing key, so what is left is everything a type cannot see: a
 * value copied across and never translated, an empty string, a function that ignores the argument
 * it was given and returns a fixed sentence, a plural that reads as a template. Those all compile
 * and all show up on screen.
 */

type Node = Record<string, unknown>

/** Every leaf path in a dictionary, so two can be compared as sets rather than by eye. */
function paths(node: Node, prefix = ""): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...paths(value as Node, path))
    } else {
      out.push(path)
    }
  }
  return out.toSorted()
}

function at(node: Node, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc as Node)?.[key], node)
}

/**
 * Calls a translation function with sample arguments and returns what it produced.
 *
 * The arity comes from the ENGLISH function, never from the one being called. TypeScript accepts
 * `() => string` where `(name: string) => string` is declared — dropping a parameter is a widening
 * it allows — so a translation that ignores what it was handed compiles cleanly and renders
 * "Rename" where the English names the tenant.
 */
function callWithSamples(fn: unknown, arity: number): string {
  const args = Array.from({ length: arity }, (_, i) => (i === 0 ? "SAMPLE" : 2))
  return String((fn as (...a: unknown[]) => unknown)(...args))
}

describe("the panel's dictionaries", () => {
  it("cover exactly the same ground", () => {
    // A key present in one and not another cannot happen — each is typed as `Dict` — but a key
    // that exists in both while one holds an object and the other a string can.
    for (const [name, dict] of Object.entries(TRANSLATIONS)) {
      expect(paths(dict as unknown as Node), name).toEqual(paths(en as unknown as Node))
    }
  })

  it("has a dictionary and a name for every language the picker offers", () => {
    // The picker is built from LOCALES, so a language listed there without a dictionary would be
    // a menu entry that blanks the panel.
    for (const locale of LOCALES) {
      expect(LOCALE_NAMES[locale], locale).toBeTruthy()
      if (locale === "en") continue
      expect(Object.keys(TRANSLATIONS), locale).toContain(locale)
    }
    // And nothing translated that the picker never shows.
    for (const name of Object.keys(TRANSLATIONS)) {
      expect(LOCALES as readonly string[], name).toContain(name)
    }
  })

  it("says something for every key", () => {
    for (const dict of [en, ...Object.values(TRANSLATIONS)]) {
      for (const path of paths(dict as unknown as Node)) {
        const value = at(dict as unknown as Node, path)
        if (typeof value === "function") continue
        if (Array.isArray(value)) {
          expect(value.length, path).toBeGreaterThan(0)
          for (const item of value) expect(String(item).trim(), path).not.toBe("")
          continue
        }
        expect(String(value).trim(), path).not.toBe("")
      }
    }
  })

  it("actually translates, rather than copying the English through", () => {
    /*
     * The failure this catches is the one nobody notices: a key added to `en.ts` and pasted into a
     * translation to make the build pass, which typechecks perfectly and shows English to someone
     * who cannot read it.
     *
     * Every key in every language is checked, not a proportion of them — a percentage threshold
     * passes a single untranslated sentence, and one sentence is all it takes for a screen to stop
     * making sense. Values that are legitimately identical are listed by name, so adding one is a
     * decision somebody made rather than a gap nobody saw.
     */
    const SAME_ON_PURPOSE = new Set([
      // Every language names a language in its own words, so these two are fixed everywhere.
      "language.english",
      "language.indonesian",
      // Loanwords and product terms carried over as they are, and vendor consoles whose menus are
      // in English wherever you open them.
      "token.label",
      "settings.provider.keyLabel",
      "tenants.columnSlug",
      "tenants.slugLabel",
      "canned.columnStatus",
      "channels.columnStatus",
      "knowledge.columnStatus",
      "settings.tabs.widget",
      "settings.form.greetingPlaceholder",
      "skills.columnSkill",
      "skills.ruleWordPlaceholder",
      "settings.provider.where.OPENAI_API_KEY",
      "settings.provider.where.ANTHROPIC_API_KEY",
      "settings.originsPlaceholder",
    ])
    for (const [name, dict] of Object.entries(TRANSLATIONS)) {
      const untranslated = paths(en as unknown as Node)
        .filter((path) => !SAME_ON_PURPOSE.has(path))
        .filter((path) => {
          const left = at(en as unknown as Node, path)
          const right = at(dict as unknown as Node, path)
          if (typeof left === "function") {
            return (
              typeof right === "function" &&
              callWithSamples(left, left.length) === callWithSamples(right, left.length)
            )
          }
          return JSON.stringify(left) === JSON.stringify(right)
        })
      expect(untranslated, name).toEqual([])
    }
  })

  it("uses the arguments it is given", () => {
    // A translated sentence that drops its parameter reads fine and says the wrong thing —
    // "Delete this?" where the English names the document being deleted. The arity is read from
    // the English side, because a translation that declares no parameters still typechecks.
    for (const path of paths(en as unknown as Node)) {
      const english = at(en as unknown as Node, path)
      if (typeof english !== "function" || english.length === 0) continue
      for (const [name, dict] of Object.entries({ en, ...TRANSLATIONS })) {
        const fn = at(dict as unknown as Node, path)
        expect(typeof fn, `${name}.${path} is not a function`).toBe("function")
        expect(
          callWithSamples(fn, english.length),
          `${name}.${path} ignores its first argument`,
        ).toContain("SAMPLE")
      }
    }
  })

  it("leaves no template syntax in the text", () => {
    // A `${...}` that survived into a string literal is a sentence that will be shown with the
    // braces in it.
    for (const dict of [en, ...Object.values(TRANSLATIONS)]) {
      for (const path of paths(dict as unknown as Node)) {
        const value = at(dict as unknown as Node, path)
        if (typeof value === "function") continue
        expect(String(value), path).not.toMatch(/\$\{|\{\{/)
      }
    }
  })
})

describe("choosing a language", () => {
  it("remembers what was chosen", () => {
    const storage = { getItem: (key: string) => (key === "quidchat-admin-locale" ? "id" : null) }
    expect(readLocale(storage, ["en-GB"])).toBe("id")
  })

  it("follows the browser when nothing was chosen", () => {
    const empty = { getItem: () => null }
    // An Indonesian shop owner opening this for the first time should not have to find a setting
    // to read their own language.
    expect(readLocale(empty, ["id-ID", "en-US"])).toBe("id")
    expect(readLocale(empty, ["en-US", "id-ID"])).toBe("en")
    // Some Android builds still send the pre-1989 code for Indonesian.
    expect(readLocale(empty, ["in-ID"])).toBe("id")
    // Traditional and Simplified both land on the one Chinese dictionary: something readable
    // beats English.
    expect(readLocale(empty, ["zh-TW"])).toBe("zh")
    expect(readLocale(empty, ["pt-BR", "en-US"])).toBe("pt")
    // A language nobody translated into falls back to English rather than to a half-translated
    // screen.
    expect(readLocale(empty, ["sw-KE"])).toBe("en")
    expect(readLocale(empty, [])).toBe("en")
  })

  it("ignores a stored value that is not a language it has", () => {
    const junk = { getItem: () => "klingon" }
    expect(readLocale(junk, ["en-US"])).toBe("en")
    expect(isLocale("klingon")).toBe(false)
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true)
  })

  it("survives a browser that refuses storage entirely", () => {
    // Blocking cookies makes `localStorage` throw on access, and a panel that will not render
    // because it could not read a language preference is a worse failure than English.
    expect(readLocale(undefined, ["id"])).toBe("id")
  })
})
