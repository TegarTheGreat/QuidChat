import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { useFetch } from "../hooks/use-fetch"
import { api } from "../lib/api"

/**
 * Provider spend is billed in US dollars whatever currency the shop itself trades in, so it is
 * labelled as dollars rather than left as a bare `$` for an Indonesian owner to interpret.
 */
function formatUsd(cents: number | undefined): string {
  if (cents === undefined) return "—"
  return `US$${(cents / 100).toFixed(2)}`
}

/**
 * The first screen, and the one that has to answer "is this working?".
 *
 * It used to show three numbers: spend, budget left, and how many escalations existed. Two of
 * those are about money and the third counted rows without saying whether any of them still
 * needed a person. None of them said whether customers were being helped.
 *
 * What it shows now is the month's questions, how many the assistant answered from the shop's own
 * documents, and how many are still waiting for an answer to be written — with the way to write
 * them one click away. Spend stays, because a budget that runs out stops the assistant, but it is
 * no longer the whole picture.
 */
export function OverviewPage({
  tenantSlug,
  onOpenEscalations,
}: {
  tenantSlug: string
  onOpenEscalations?: () => void
}) {
  const usage = useFetch(() => api.getUsage(tenantSlug), [tenantSlug])
  const settings = useFetch(() => api.getSettings(tenantSlug), [tenantSlug])

  const usageCents = usage.status === "success" ? usage.data.costCents : undefined
  const budgetCents = settings.status === "success" ? settings.data.monthly_budget_cents : undefined
  const remainingCents =
    budgetCents !== undefined && usageCents !== undefined ? budgetCents - usageCents : undefined
  const spentShare =
    budgetCents !== undefined && budgetCents > 0 && usageCents !== undefined
      ? Math.min(100, Math.round((usageCents / budgetCents) * 100))
      : undefined

  const questions = usage.status === "success" ? usage.data.questions : undefined
  const refusals = usage.status === "success" ? usage.data.refusals : undefined
  const answered =
    questions !== undefined && refusals !== undefined ? Math.max(0, questions - refusals) : undefined
  const answeredShare =
    questions !== undefined && questions > 0 && answered !== undefined
      ? Math.round((answered / questions) * 100)
      : undefined
  const open = usage.status === "success" ? usage.data.openEscalations : undefined

  const loading = usage.status === "pending"

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Overview</h1>

      {usage.status === "error" && <MutationError message={usage.message} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Questions this month</CardDescription>
            <CardTitle className="text-2xl">
              {loading ? <Skeleton className="h-8 w-16" /> : (questions ?? "—")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            From your website and every channel you have connected.
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Answered from your documents</CardDescription>
            <CardTitle className="text-2xl">
              {loading ? (
                <Skeleton className="h-8 w-16" />
              ) : answeredShare === undefined ? (
                "—"
              ) : (
                `${answeredShare}%`
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {answered === undefined
              ? "No questions yet this month."
              : `${answered} answered, ${refusals} declined rather than guessed at.`}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Waiting for an answer</CardDescription>
            <CardTitle className="text-2xl">
              {loading ? <Skeleton className="h-8 w-12" /> : (open ?? "—")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>
              {open === 0
                ? "Nothing outstanding."
                : "Each one is a customer question your documents did not cover."}
            </p>
            {open !== undefined && open > 0 && onOpenEscalations && (
              <Button size="sm" variant="outline" onClick={onOpenEscalations}>
                Answer them
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Spent this month</CardDescription>
            <CardTitle className="text-2xl">
              {loading ? <Skeleton className="h-8 w-24" /> : formatUsd(usageCents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            {settings.status === "error" && <MutationError message={settings.message} />}
            {spentShare !== undefined && (
              // A budget that runs out stops the assistant answering, so how close it is matters
              // more than the figure itself.
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={spentShare}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Share of this month's budget spent"
              >
                <div
                  className={spentShare >= 90 ? "h-full bg-destructive" : "h-full bg-primary"}
                  style={{ width: `${spentShare}%` }}
                />
              </div>
            )}
            <p>
              {budgetCents === undefined
                ? "Loading your budget…"
                : budgetCents === 0
                  ? "No monthly limit set. Set one in Settings before this runs on a live site."
                  : `${formatUsd(remainingCents)} left of ${formatUsd(budgetCents)}. The assistant stops answering when it runs out.`}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
