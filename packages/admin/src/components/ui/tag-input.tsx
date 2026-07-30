import * as React from "react"
import { X } from "lucide-react"
import { Badge } from "./badge"
import { Input } from "./input"
import { cn } from "../../lib/utils"

export interface TagInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
  "aria-label"?: string
}

/**
 * Tag-style editor for array settings fields (`high_risk_topics`,
 * `allowed_origins`). Deliberately not a comma-separated text box: a business
 * owner should be able to see and remove exactly one value at a time.
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  className,
  ...rest
}: TagInputProps) {
  const [draft, setDraft] = React.useState("")

  function commitDraft() {
    const next = draft.trim()
    setDraft("")
    if (next.length === 0) return
    if (value.includes(next)) return
    onChange([...value, next])
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index))
  }

  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring",
        className,
      )}
    >
      {value.map((tag, index) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1">
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => removeAt(index)}
            className="rounded-sm opacity-70 hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <Input
        {...rest}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault()
            commitDraft()
          } else if (event.key === "Backspace" && draft.length === 0 && value.length > 0) {
            removeAt(value.length - 1)
          }
        }}
        onBlur={commitDraft}
        className="h-6 flex-1 border-0 p-0 shadow-none focus-visible:ring-0"
      />
    </div>
  )
}
