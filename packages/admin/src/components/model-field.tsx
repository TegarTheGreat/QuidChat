import * as React from "react"
import { Input } from "./ui/input"
import { useT } from "../i18n"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"

/**
 * Choosing a model, rather than typing one.
 *
 * A text box here was the worst kind of setting: a typo, or a name that was right last year,
 * produces `unknown_model` on every question a customer asks — reported by the vendor, at answer
 * time, to an owner with no way to connect it back to the box they filled in.
 *
 * The options come from the service itself, so they cannot go stale and cannot be invented here.
 * When the service cannot be asked — no key yet, a local runner that is not running — this falls
 * back to a text box and says why, because a screen that only offers an empty dropdown is one
 * nobody can finish.
 */
export function ModelField({
  value,
  models,
  error,
  onChange,
  ariaLabel,
}: {
  value: string
  models: string[]
  error: string | null
  onChange: (next: string) => void
  ariaLabel: string
}): React.ReactElement {
  const t = useT()
  // A model the tenant already uses but the service no longer lists must stay selectable, or
  // opening this screen would silently offer to change a working setting.
  const options = React.useMemo(
    () => (value && !models.includes(value) ? [value, ...models] : models),
    [value, models],
  )

  if (options.length === 0) {
    return (
      <>
        <Input value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} />
        <p className="mt-1 text-xs text-muted-foreground">
          {error ?? t.settings.modelsUnavailable}
        </p>
      </>
    )
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {options.map((id) => (
          <SelectItem key={id} value={id}>
            {id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
