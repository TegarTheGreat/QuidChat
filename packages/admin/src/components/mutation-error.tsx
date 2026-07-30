import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "./ui/alert"

/**
 * Renders a server error message verbatim. The admin API is documented to
 * return actionable text (an unknown settings column, a missing origin) —
 * wrapping it in a generic "something went wrong" would throw that away.
 */
export function MutationError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertTitle>Request failed</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
