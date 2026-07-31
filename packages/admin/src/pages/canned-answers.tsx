import * as React from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { ConfirmDialog } from "../components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { RowActions } from "../components/row-actions"
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

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<CannedAnswer | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<CannedAnswer | null>(null)

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setReloadKey((k) => k + 1)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }



  const rows: CannedAnswer[] = data.status === "success" ? data.data.cannedAnswers : []
  const draftCount = rows.filter((r) => r.status === "draft").length

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
        <h1 className="text-2xl font-semibold">Canned answers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Exact answers to exact questions, matched without calling a model. In{" "}
          <code className="rounded bg-muted px-1">static</code> mode these are the only thing
          the assistant can say, so it costs nothing to run.
        </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add answer
        </Button>
      </div>

      {error && <MutationError message={error} />}

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
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {/* Approving stays a visible button: it is the whole workflow of this
                                screen, and burying the step that puts text in front of customers
                                inside a menu would make it easier to do without noticing. */}
                            <Button
                              type="button"
                              size="sm"
                              variant={row.status === "approved" ? "ghost" : "default"}
                              disabled={busy}
                              onClick={() =>
                                void act(() =>
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
                            <RowActions
                              label={`Actions for ${row.question}`}
                              actions={[
                                { label: "Edit", disabled: busy, onSelect: () => setEditing(row) },
                                {
                                  label: "Delete",
                                  destructive: true,
                                  disabled: busy,
                                  onSelect: () => setPendingDelete(row),
                                },
                              ]}
                            />
                          </div>
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

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AnswerDialog
            title="Add an answer"
            description="Matching tolerates different wording and typos, so write the question the way a customer would — not as a keyword."
            busy={busy}
            onSubmit={async (values) => {
              const ok = await act(() =>
                api.createCannedAnswer({
                  tenantSlug,
                  question: values.question,
                  answer: values.answer,
                  // A person typed this into this form. That IS the review the draft state
                  // exists to require, so asking them to approve their own text on a second
                  // screen would be ceremony rather than a safeguard.
                  approved: true,
                }),
              )
              if (ok) setAdding(false)
            }}
            submitLabel="Add and approve"
          />
        )}
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <AnswerDialog
            title="Edit this answer"
            description="Saving sends it back to draft — the approval was for the old words, and a person should read the new ones before a customer does."
            busy={busy}
            initial={{ question: editing.question, answer: editing.answer }}
            submitLabel="Save as draft"
            onSubmit={async (values) => {
              const ok = await act(() =>
                api.updateCannedAnswer({
                  tenantSlug,
                  id: editing.id,
                  question: values.question,
                  answer: values.answer,
                }),
              )
              if (ok) setEditing(null)
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete “${pendingDelete?.question}”?`}
        description="Customers asking this go back to being answered from the documents, or refused if nothing covers it."
        confirmLabel="Delete answer"
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          if (!target) return
          void act(async () => {
            await api.deleteCannedAnswer({ tenantSlug, id: target.id })
            setPendingDelete(null)
          })
        }}
      />
    </div>
  )
}

/** One form for adding and for editing — identical fields, and two copies would drift. */
function AnswerDialog({
  title,
  description,
  initial,
  busy,
  submitLabel,
  onSubmit,
}: {
  title: string
  description: string
  initial?: { question: string; answer: string }
  busy: boolean
  submitLabel: string
  onSubmit: (values: { question: string; answer: string }) => void
}): React.ReactElement {
  const [question, setQuestion] = React.useState(initial?.question ?? "")
  const [answer, setAnswer] = React.useState(initial?.answer ?? "")

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="canned-question">Question a customer would ask</Label>
          <Input
            id="canned-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How long is the warranty?"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="canned-answer">Answer to send, word for word</Label>
          <Textarea
            id="canned-answer"
            rows={4}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Every unit carries a one-year warranty from the purchase date."
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={busy || question.trim() === "" || answer.trim() === ""}
          onClick={() => onSubmit({ question: question.trim(), answer: answer.trim() })}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
