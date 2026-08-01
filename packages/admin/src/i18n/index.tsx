import * as React from "react"
import { en, type Dict } from "./en.js"
import { es } from "./es.js"
import { hi } from "./hi.js"
import { id } from "./id.js"
import { ja } from "./ja.js"
import { ko } from "./ko.js"
import { ms } from "./ms.js"
import { pt } from "./pt.js"
import { ru } from "./ru.js"
import { zh } from "./zh.js"

/**
 * The panel's own language.
 *
 * Separate from the widget's, deliberately. The widget's language is a property of the shop and
 * belongs to its customers; this is a property of the person reading the panel, and one server can
 * be operated by someone who reads English for a business whose customers read Indonesian. Storing
 * it per browser rather than per tenant follows from that.
 *
 * No dependency and no key strings: `useT()` returns the dictionary itself, so every use is a
 * property access the compiler checks. `t("setup.titel")` cannot be caught by anything until it is
 * on screen; `t.setup.titel` does not build.
 */

/**
 * Ordered by how many of this product's users read them, not alphabetically: Indonesian and
 * English first because that is who runs it today, then the languages a shop is most likely to
 * need next. The picker shows them in this order.
 */
export const LOCALES = ["en", "id", "ms", "zh", "hi", "es", "pt", "ru", "ja", "ko"] as const
export type Locale = (typeof LOCALES)[number]

const DICTS: Record<Locale, Dict> = { en, id, ms, zh, hi, es, pt, ru, ja, ko }

/** Each language names itself, because whoever is looking for it cannot read the current one. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  id: "Bahasa Indonesia",
  ms: "Bahasa Melayu",
  zh: "中文",
  hi: "हिन्दी",
  es: "Español",
  pt: "Português",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
}

const STORAGE_KEY = "quidchat-admin-locale"

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
}

/**
 * The language to start in.
 *
 * A stored choice wins. Otherwise the browser's own preference decides, so an Indonesian shop
 * owner opening this for the first time gets Indonesian without being told a setting exists —
 * which is the moment they are least likely to go looking for one. Anything else is English,
 * because a half-translated screen is worse than a foreign one.
 */
export function readLocale(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [],
): Locale {
  const stored = storage?.getItem(STORAGE_KEY)
  if (isLocale(stored)) return stored
  for (const tag of languages) {
    const base = tag.toLowerCase().split("-")[0]
    // `in` is the pre-1989 code for Indonesian that some Android builds still send; `iw` is the
    // same story for Hebrew, which is not translated here and so falls through.
    if (base === "in") return "id"
    // Every Chinese variant maps to the one dictionary. Simplified is what it is written in, and
    // a Traditional reader gets something they can read rather than English.
    if (base === "zh") return "zh"
    if (isLocale(base)) return base
  }
  return "en"
}

/** localStorage throws in a browser with cookies blocked entirely, and a panel that will not
 *  render because it could not read a language preference is a worse failure than English. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

type LocaleState = { locale: Locale; t: Dict; setLocale: (next: Locale) => void }

const LocaleContext = React.createContext<LocaleState>({
  locale: "en",
  t: en,
  setLocale: () => {},
})

export function LocaleProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [locale, setLocaleState] = React.useState<Locale>(() => readLocale())

  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      safeStorage()?.setItem(STORAGE_KEY, next)
    } catch {
      // Not worth telling anyone about: the choice holds for this session either way.
    }
    // So a screen reader announces the page in the right language, and so a browser offers to
    // translate the one it is not showing.
    if (typeof document !== "undefined") document.documentElement.lang = next
  }, [])

  React.useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = locale
  }, [locale])

  const value = React.useMemo<LocaleState>(
    () => ({ locale, t: DICTS[locale], setLocale }),
    [locale, setLocale],
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

/** The dictionary for the current language. Every lookup is a checked property access. */
export function useT(): Dict {
  return React.useContext(LocaleContext).t
}

export function useLocale(): { locale: Locale; setLocale: (next: Locale) => void } {
  const { locale, setLocale } = React.useContext(LocaleContext)
  return { locale, setLocale }
}

export { en, es, hi, id, ja, ko, ms, pt, ru, zh }
export type { Dict }
