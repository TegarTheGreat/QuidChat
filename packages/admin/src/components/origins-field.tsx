import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "./ui/alert"
import { TagInput } from "./ui/tag-input"
import { useT } from "../i18n"

/**
 * Editor for `allowed_origins`. An empty allowlist refuses every site, which
 * from a business owner's point of view looks exactly like a broken widget
 * rather than one that is simply unconfigured yet — so we say so, loudly.
 */
export function OriginsField({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const t = useT()
  return (
    <div className="space-y-2">
      <TagInput
        value={value}
        onChange={onChange}
        placeholder={t.settings.originsPlaceholder}
        aria-label={t.settings.fields.allowedOrigins}
      />
      {value.length === 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{t.settings.widgetDisabledTitle}</AlertTitle>
          <AlertDescription>{t.settings.widgetDisabledBody}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
