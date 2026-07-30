import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { useFetch } from "../hooks/use-fetch"
import { api } from "../lib/api"

function formatCents(cents: number | undefined): string {
  if (cents === undefined) return "—"
  return `$${(cents / 100).toFixed(2)}`
}

export function OverviewPage({ tenantSlug }: { tenantSlug: string }) {
  const usage = useFetch(() => api.getUsage(tenantSlug), [tenantSlug])
  const settings = useFetch(() => api.getSettings(tenantSlug), [tenantSlug])
  const escalations = useFetch(() => api.listEscalations(tenantSlug), [tenantSlug])

  const usageCents = usage.status === "success" ? usage.data.costCents : undefined
  const budgetCents = settings.status === "success" ? settings.data.monthly_budget_cents : undefined
  const remainingCents =
    budgetCents !== undefined && usageCents !== undefined ? budgetCents - usageCents : undefined

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Overview</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Usage this month</CardDescription>
            <CardTitle className="text-2xl">
              {usage.status === "pending" ? <Skeleton className="h-8 w-24" /> : formatCents(usageCents)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {usage.status === "error" && <MutationError message={usage.message} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Budget remaining</CardDescription>
            <CardTitle className="text-2xl">
              {settings.status === "pending" || usage.status === "pending" ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                formatCents(remainingCents)
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {settings.status === "error" && <MutationError message={settings.message} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Recent escalations</CardDescription>
            <CardTitle className="text-2xl">
              {escalations.status === "pending" ? (
                <Skeleton className="h-8 w-12" />
              ) : escalations.status === "success" ? (
                escalations.data.length
              ) : (
                "—"
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {escalations.status === "error" && <MutationError message={escalations.message} />}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
