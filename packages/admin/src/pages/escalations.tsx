import * as React from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table"
import { Textarea } from "../components/ui/textarea"
import { useFetch } from "../hooks/use-fetch"
import { useMutation } from "../hooks/use-mutation"
import { formatRelative } from "../lib/format"
import { useT, type Dict } from "../i18n"
import { api, type Escalation } from "../lib/api"

/** Plain-language headings. `no_source` is the database's word for it, not a business
 *  owner's, and this screen exists to tell them what to do next. */
function reasonTitle(t: Dict, reason: string): string {
  return t.escalations.reasons[reason] ?? reason
}

function groupByReason(escalations: Escalation[]): [string, Escalation[]][] {
  const groups = new Map<string, Escalation[]>()
  for (const escalation of escalations) {
    const list = groups.get(escalation.reason) ?? []
    list.push(escalation)
    groups.set(escalation.reason, list)
  }
  return [...groups.entries()].toSorted((a, b) => b[1].length - a[1].length)
}

/**
 * Escalations — every question the assistant declined to answer.
 *
 * Grouped by reason, because the reason decides what to do: a hundred `no_source` rows mean
 * knowledge is missing, while a hundred `provider_unavailable` rows mean nothing is missing at
 * all and someone should look at the provider. A flat table would make those look alike.
 *
 * Each row can be answered on the spot. That is the loop this product lives or dies by: a
 * customer asks something the business never wrote down, the owner reads the actual question
 * here and writes one sentence, and the next customer to ask gets an answer. Making them
 * copy the question into another screen is where that loop breaks.
 */
export function EscalationsPage({ tenantSlug }: { tenantSlug: string }) {
  const t = useT()
  const [reloadKey, setReloadKey] = React.useState(0)
  const escalations = useFetch(() => api.listEscalations(tenantSlug), [tenantSlug, reloadKey])

  const [answering, setAnswering] = React.useState<Escalation | null>(null)
  const [answer, setAnswer] = React.useState("")
  const [rowError, setRowError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const { state: saveState, mutate: saveAnswer } = useMutation(api.createCannedAnswer)

  /**
   * Marking one handled, or putting it back.
   *
   * This used to be a bare `.then()` with nothing on the other side of a failure: the button did
   * nothing, the row did not change, and the screen said the same as it had before. A queue whose
   * dismiss button silently fails is worse than one without a dismiss button, because an owner
   * believes they have cleared it.
   */
  async function setResolved(escalation: Escalation, resolved: boolean): Promise<void> {
    setBusyId(escalation.id)
    setRowError(null)
    try {
      await api.resolveEscalation({ tenantSlug, id: escalation.id, resolved })
      setReloadKey((k) => k + 1)
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }

  function startAnswering(escalation: Escalation) {
    setAnswering(escalation)
    setAnswer("")
  }

  async function submitAnswer() {
    if (!answering?.question) return
    await saveAnswer({
      tenantSlug,
      question: answering.question,
      answer,
      // Approved as it is saved: the person writing it here IS the review that the draft state
      // exists to require, and an answer that sits as a draft would leave the next customer
      // refused for the same question the owner just answered.
      approved: true,
    })
    // Marked handled in the same step. Writing the answer IS handling it, and leaving the row
    // open would make this queue grow forever no matter how much work someone did on it. Done
    // after the answer is saved, so a failure to save never marks anything as handled.
    try {
      await api.resolveEscalation({ tenantSlug, id: answering.id, resolved: true })
    } catch (cause) {
      // The answer is saved either way, and saying so matters: retrying from a blank dialog
      // would write it a second time.
      setRowError(
        t.escalations.savedNotResolved(cause instanceof Error ? cause.message : String(cause)),
      )
    }
    setAnswering(null)
    setAnswer("")
    setReloadKey((k) => k + 1)
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t.escalations.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.escalations.description}</p>
      </div>

      {escalations.status === "pending" && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {escalations.status === "error" && <MutationError message={escalations.message} />}
      {rowError && <MutationError message={rowError} />}

      {escalations.status === "success" && (
        <div className="space-y-4">
          {escalations.data.length === 0 && (
            <p className="text-sm text-muted-foreground">{t.escalations.empty}</p>
          )}
          {groupByReason(escalations.data).map(([reason, group]) => (
            <Card key={reason}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">{reasonTitle(t, reason)}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">{reason}</p>
                </div>
                <Badge variant="secondary">{group.length}</Badge>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.escalations.columnQuestion}</TableHead>
                        <TableHead>{t.escalations.columnWhen}</TableHead>
                        <TableHead>{t.escalations.columnState}</TableHead>
                        <TableHead className="text-right">{t.escalations.columnAnswer}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.map((escalation) => (
                        <TableRow key={escalation.id}>
                          <TableCell className="font-medium">
                            {escalation.question ?? (
                              <span className="text-muted-foreground">
                                {t.escalations.noQuestion}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatRelative(escalation.occurredAt)}
                          </TableCell>
                          <TableCell>
                            {escalation.resolvedAt ? (
                              <Badge variant="secondary">{t.escalations.handled}</Badge>
                            ) : (
                              <Badge variant="outline">{t.escalations.open}</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              // Nothing to answer without a question, and a dialog with an
                              // empty prompt would be a dead end rather than a feature.
                              disabled={!escalation.question}
                              onClick={() => startAnswering(escalation)}
                            >
                              {t.escalations.writeAnswer}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="ml-2"
                              disabled={busyId === escalation.id}
                              // Some escalations need no answer — a provider outage, a budget
                              // that has since been raised. Dismissing one has to be possible
                              // without inventing a canned answer for it.
                              onClick={() => void setResolved(escalation, !escalation.resolvedAt)}
                            >
                              {escalation.resolvedAt ? t.escalations.reopen : t.escalations.dismiss}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={answering !== null} onOpenChange={(open) => !open && setAnswering(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.escalations.dialog.title}</DialogTitle>
            <DialogDescription>{t.escalations.dialog.description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t.escalations.dialog.question}</Label>
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {answering?.question}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="escalation-answer">{t.escalations.dialog.answer}</Label>
              <Textarea
                id="escalation-answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={4}
                placeholder={t.escalations.dialog.answerPlaceholder}
              />
            </div>
            {saveState.status === "error" && <MutationError message={saveState.message} />}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAnswering(null)}>
              {t.common.cancel}
            </Button>
            <Button
              type="button"
              disabled={saveState.status === "pending" || answer.trim() === ""}
              onClick={submitAnswer}
            >
              {saveState.status === "pending" ? t.common.saving : t.escalations.dialog.submit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
