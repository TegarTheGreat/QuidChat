import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table"
import { useFetch } from "../hooks/use-fetch"
import { api, type Escalation } from "../lib/api"

function groupByReason(escalations: Escalation[]): [string, Escalation[]][] {
  const groups = new Map<string, Escalation[]>()
  for (const escalation of escalations) {
    const list = groups.get(escalation.reason) ?? []
    list.push(escalation)
    groups.set(escalation.reason, list)
  }
  return [...groups.entries()].toSorted((a, b) => b[1].length - a[1].length)
}

/** Grouped by reason so the owner can see *why* the bot could not answer —
 *  that tells them what to write next, more than a flat table would. */
export function EscalationsPage({ tenantSlug }: { tenantSlug: string }) {
  const escalations = useFetch(() => api.listEscalations(tenantSlug), [tenantSlug])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Escalations</h1>
      {escalations.status === "pending" && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {escalations.status === "error" && <MutationError message={escalations.message} />}
      {escalations.status === "success" && (
        <div className="space-y-4">
          {escalations.data.length === 0 && (
            <p className="text-sm text-muted-foreground">No escalations recorded.</p>
          )}
          {groupByReason(escalations.data).map(([reason, group]) => (
            <Card key={reason}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{reason}</CardTitle>
                <Badge variant="secondary">{group.length}</Badge>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Conversation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.map((escalation) => (
                      <TableRow key={escalation.id}>
                        <TableCell>{escalation.createdAt}</TableCell>
                        <TableCell>{escalation.conversationId ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
