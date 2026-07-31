import * as React from "react"
import { MoreHorizontal } from "lucide-react"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"

/**
 * What can be done to one row.
 *
 * Every screen here listed things and then offered almost nothing to do with them: a skill could
 * be created and never renamed, edited, switched off or deleted; a routing rule could be added and
 * never removed. The list was a display, not a place of work.
 *
 * One menu per row rather than a strip of buttons, because a strip grows with every capability
 * until the row is mostly controls, and because the destructive one should not sit under a
 * mis-tap next to the safe ones. Destructive items are separated and coloured, and the menu is
 * reachable by keyboard, which a hover-revealed button never is.
 */

export type RowAction = {
  label: string
  onSelect: () => void
  /** Puts it below a separator, in the destructive colour. */
  destructive?: boolean
  disabled?: boolean
}

export function RowActions({
  actions,
  label,
}: {
  actions: RowAction[]
  /** Names the row for a screen reader — "Actions" alone, repeated down a table, says nothing. */
  label: string
}): React.ReactElement | null {
  const safe = actions.filter((a) => !a.destructive)
  const destructive = actions.filter((a) => a.destructive)
  if (actions.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={label}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {safe.map((action) => (
          <DropdownMenuItem
            key={action.label}
            {...(action.disabled === undefined ? {} : { disabled: action.disabled })}
            onSelect={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
        {safe.length > 0 && destructive.length > 0 && <DropdownMenuSeparator />}
        {destructive.map((action) => (
          <DropdownMenuItem
            key={action.label}
            {...(action.disabled === undefined ? {} : { disabled: action.disabled })}
            onSelect={action.onSelect}
            className="text-destructive focus:text-destructive"
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
