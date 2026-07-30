import { AlertTriangle, CheckCircle2, CircleAlert, Lightbulb } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { useFetch } from "../hooks/use-fetch"
import { api, type SetupFinding } from "../lib/api"

/**
 * Severity carried by colour and icon, not only by a word in a badge.
 *
 * Every card looked identical, so a blocker — the thing stopping customers getting answers at
 * all — read the same as a suggestion about saving money. An owner scanning this page should be
 * able to tell those apart without reading, which is the entire job of the left rail here.
 */
const TONE: Record<
  SetupFinding["severity"],
  {
    label: string
    variant: "destructive" | "secondary" | "outline"
    rail: string
    icon: typeof CircleAlert
    iconClass: string
  }
> = {
  blocker: {
    label: "Blocking",
    variant: "destructive",
    rail: "border-l-4 border-l-destructive",
    icon: CircleAlert,
    iconClass: "text-destructive",
  },
  warning: {
    label: "Warning",
    variant: "secondary",
    rail: "border-l-4 border-l-amber-500",
    icon: AlertTriangle,
    iconClass: "text-amber-500",
  },
  suggestion: {
    label: "Suggestion",
    variant: "outline",
    rail: "border-l-4 border-l-muted-foreground/40",
    icon: Lightbulb,
    iconClass: "text-muted-foreground",
  },
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
          <Alert
            variant={setup.data.ready ? "default" : "destructive"}
            className={setup.data.ready ? "border-l-4 border-l-emerald-500" : undefined}
          >
            {setup.data.ready ? (
              <CheckCircle2 className="size-4 text-emerald-500" />
            ) : (
              <CircleAlert className="size-4" />
            )}
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

          {setup.data.findings.map((finding) => {
            const tone = TONE[finding.severity]
            const Icon = tone.icon
            return (
            <Card key={finding.id} className={tone.rail}>
              <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className={`size-4 shrink-0 ${tone.iconClass}`} />
                  {finding.title}
                </CardTitle>
                <Badge variant={tone.variant}>{tone.label}</Badge>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">{finding.why}</p>
                <p>
                  <span className="font-medium">What to do: </span>
                  {finding.fix}
                </p>
              </CardContent>
            </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
