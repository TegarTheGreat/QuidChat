import * as React from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table"
import { Textarea } from "../components/ui/textarea"
import { useFetch } from "../hooks/use-fetch"
import { api, type CannedAnswer } from "../lib/api"

/**
 * Canned answers — the only thing `static` mode can say.
 *
 * Approval is shown as a state with a button next to it rather than a checkbox on the form,
 * because approval is what makes static mode trustworthy for price and warranty questions:
 * a customer only ever receives text a person approved. A draft is invisible to matching, so
 * this screen is the only place one can be seen at all — which is why drafts are listed
 * first, and why nothing here hides them.
 */
export function CannedAnswersPage({ tenantSlug }: { tenantSlug: string }) {
  const [reloadKey, setReloadKey] = React.useState(0)
  const data = useFetch(() => api.listCannedAnswers(tenantSlug), [tenantSlug, reloadKey])

  const [question, setQuestion] = React.useState("")
  const [answer, setAnswer] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setReloadKey((k) => k + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault()
    await act(async () => {
      await api.createCannedAnswer({
        tenantSlug,
        question,
        answer,
        // A person typed this answer into this form. That IS the review the draft state
        // exists to require, so asking them to approve their own text on a second screen
        // would be ceremony rather than a safeguard.
        approved: true,
      })
      setQuestion("")
      setAnswer("")
    })
  }

  const rows: CannedAnswer[] = data.status === "success" ? data.data.cannedAnswers : []
  const draftCount = rows.filter((r) => r.status === "draft").length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Canned answers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Exact answers to exact questions, matched without calling a model. In{" "}
          <code className="rounded bg-muted px-1">static</code> mode these are the only thing
          the assistant can say, so it costs nothing to run.
        </p>
      </div>

      {error && <MutationError message={error} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add an answer</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="canned-question">Question a customer would ask</Label>
              <Input
                id="canned-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="How long is the warranty?"
              />
              <p className="text-xs text-muted-foreground">
                Matching tolerates different wording and typos, so write it the way a customer
                would — not as a keyword.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="canned-answer">Answer to send, word for word</Label>
              <Textarea
                id="canned-answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Every unit carries a one-year warranty from the purchase date."
              />
            </div>
            <Button type="submit" disabled={busy || question.trim() === "" || answer.trim() === ""}>
              {busy ? "Saving…" : "Add and approve"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {data.status === "pending" && <Skeleton className="h-40 w-full" />}
      {data.status === "error" && <MutationError message={data.message} />}

      {data.status === "success" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {rows.length} answer{rows.length === 1 ? "" : "s"}
              {draftCount > 0 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {draftCount} waiting for approval
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing yet. A tenant in static mode with no approved answers refuses every
                question — deliberately, since the alternative is inventing one.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Question</TableHead>
                      <TableHead>Answer</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.question}</TableCell>
                        <TableCell className="max-w-md text-muted-foreground">{row.answer}</TableCell>
                        <TableCell>
                          {row.status === "approved" ? (
                            <Badge variant="secondary">Live</Badge>
                          ) : (
                            <Badge variant="outline">Draft — not sent</Badge>
                          )}
                        </TableCell>
                        <TableCell className="space-x-2 text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              act(() =>
                                api.setCannedAnswerStatus({
                                  tenantSlug,
                                  id: row.id,
                                  approved: row.status !== "approved",
                                }),
                              )
                            }
                          >
                            {row.status === "approved" ? "Withdraw" : "Approve"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => act(() => api.deleteCannedAnswer({ tenantSlug, id: row.id }))}
                          >
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
