import * as React from "react"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import { MutationError } from "./mutation-error"

/**
 * Asking before something cannot be undone.
 *
 * The title names the thing, always. A dialog that says "Are you sure?" is one people learn to
 * click through without reading, and then the one time it mattered they had the wrong row
 * selected. The description says what actually happens — not that the action is dangerous, which
 * they can see from the button.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  error,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: React.ReactNode
  description: React.ReactNode
  confirmLabel: string
  error?: string | null
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <MutationError message={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
