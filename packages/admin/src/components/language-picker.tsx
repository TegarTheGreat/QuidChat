import * as React from "react"
import { Languages } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { SidebarMenuButton } from "./ui/sidebar"
import { LOCALES, LOCALE_NAMES, useT, type Locale } from "../i18n"

/**
 * Switching the panel's language.
 *
 * Each language names itself in its own words — "Bahasa Indonesia", not "Indonesian" — because
 * the person looking for it is by definition not reading the current one.
 *
 * It sits in the sidebar footer rather than inside the settings dialog: settings are per tenant
 * and this is per reader, and someone who cannot read the panel needs this before they can find
 * anything inside it.
 */
export function LanguagePicker({
  locale,
  onChange,
}: {
  locale: Locale
  onChange: (next: Locale) => void
}): React.ReactElement {
  const t = useT()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* A stable hook for the browser checks: every label on this button is translated, so
            selecting it by its text would break in exactly the language being tested. */}
        <SidebarMenuButton tooltip={t.language.label} data-quidchat="language-picker">
          <Languages />
          <span>{LOCALE_NAMES[locale]}</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-60">
        <DropdownMenuLabel>{t.language.label}</DropdownMenuLabel>
        {LOCALES.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => onChange(option)}>
            {LOCALE_NAMES[option]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* Said here because the two are easy to confuse, and confusing them means a shop
            switches its own customers into a language they do not read. */}
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t.language.hint}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
