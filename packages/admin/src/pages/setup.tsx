import { AlertTriangle, CheckCircle2, CircleAlert, Lightbulb } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { useFetch } from "../hooks/use-fetch"
import { Button } from "../components/ui/button"
import type { Section } from "../components/app-sidebar"
import { api, type SetupFinding } from "../lib/api"

/**
 * Where each finding is fixed.
 *
 * Advice that names a problem and leaves the reader to work out which screen owns it is advice
 * with a gap in the middle. The ids come from the advisor in `@quidchat/core`; a finding not
 * listed here simply shows no button, which is the right failure for a new one nobody has
 * mapped yet.
 */
type FixTarget = { kind: "section"; section: Section; label: string } | { kind: "settings"; label: string }

const FIX_LOCATION: Record<string, FixTarget> = {
  // Settings live in a dialog rather than on a screen, so these open it directly. Sending a
  // reader to a page that does not hold the setting would be worse than saying nothing.
  "no-allowed-origins": { kind: "settings", label: "Open settings" },
  "no-budget-limit": { kind: "settings", label: "Open settings" },
  "budget-exhausted": { kind: "settings", label: "Open settings" },
  "budget-nearly-exhausted": { kind: "settings", label: "Open settings" },
  "empty-refusal-text": { kind: "settings", label: "Open settings" },
  "no-high-risk-topics": { kind: "settings", label: "Open settings" },
  "no-sources": { kind: "section", section: "knowledge", label: "Add a document" },
  "sources-not-indexed": { kind: "section", section: "knowledge", label: "See your sources" },
  "errored-sources": { kind: "section", section: "knowledge", label: "See what failed" },
  "static-mode-no-approved-answers": { kind: "section", section: "canned", label: "Write an answer" },
  "consider-canned-answers": { kind: "section", section: "canned", label: "Write an answer" },
  "many-no-source-escalations": { kind: "section", section: "escalations", label: "Read the questions" },
}

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
export function SetupPage({
  tenantSlug,
  onGoTo,
  onOpenSettings,
}: {
  tenantSlug: string
  /** Navigates to the screen that owns a finding. Both are optional so the page still renders in
   *  isolation — a test or a future embed should not have to supply navigation to see it. */
  onGoTo?: (section: Section) => void
  onOpenSettings?: () => void
}) {
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
{(() => {
                  const target = FIX_LOCATION[finding.id]
                  if (!target) return null
                  const go =
                    target.kind === "settings"
                      ? onOpenSettings
                      : onGoTo && (() => onGoTo(target.section))
                  if (!go) return null
                  return (
                    <Button type="button" size="sm" variant="outline" onClick={go}>
                      {target.label}
                    </Button>
                  )
                })()}
              </CardContent>
            </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
