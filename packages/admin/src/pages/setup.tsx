import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { useFetch } from "../hooks/use-fetch"
import { api, type SetupFinding } from "../lib/api"

const TONE: Record<SetupFinding["severity"], { label: string; variant: "destructive" | "secondary" | "outline" }> = {
  blocker: { label: "Blocking", variant: "destructive" },
  warning: { label: "Warning", variant: "secondary" },
  suggestion: { label: "Suggestion", variant: "outline" },
}

/**
 * The first screen an owner should read.
 *
 * A brand new installation is technically valid and answers nothing, because there is no
 * content and no allowed origin — and nothing else in the product says so. The advice is
 * ordered blockers first, because a first-time owner reads the top of a list and stops.
 *
 * Every finding shows why it matters and what to do. A finding without an action is just
 * bad news, which is worse than silence.
 */
export function SetupPage({ tenantSlug }: { tenantSlug: string }) {
  const setup = useFetch(() => api.getSetup(tenantSlug), [tenantSlug])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Setup</h1>

      {setup.status === "pending" && (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {setup.status === "error" && <MutationError message={setup.message} />}

      {setup.status === "success" && (
        <div className="space-y-4">
          <Alert variant={setup.data.ready ? "default" : "destructive"}>
            <AlertTitle>
              {setup.data.ready ? "Ready to answer customers" : "Not answering yet"}
            </AlertTitle>
            <AlertDescription>
              {setup.data.ready
                ? "Nothing is blocking the assistant. Anything below is optional polish."
                : "Something below has to be fixed before a customer can get an answer."}
            </AlertDescription>
          </Alert>

          {setup.data.findings.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing to report — this tenant is fully configured.
            </p>
          )}

          {setup.data.findings.map((finding) => (
            <Card key={finding.id}>
              <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
                <CardTitle className="text-base">{finding.title}</CardTitle>
                <Badge variant={TONE[finding.severity].variant}>
                  {TONE[finding.severity].label}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">{finding.why}</p>
                <p>
                  <span className="font-medium">What to do: </span>
                  {finding.fix}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
