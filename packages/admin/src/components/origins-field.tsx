import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "./ui/alert"
import { TagInput } from "./ui/tag-input"

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
  return (
    <div className="space-y-2">
      <TagInput
        value={value}
        onChange={onChange}
        placeholder="https://example.com"
        aria-label="Allowed origins"
      />
      {value.length === 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Widget disabled</AlertTitle>
          <AlertDescription>
            No allowed origins are configured, so the widget will refuse every
            site. Add at least one origin to enable it.
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
