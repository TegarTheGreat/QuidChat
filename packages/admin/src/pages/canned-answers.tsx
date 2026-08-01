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
import { useT } from "../i18n"
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
  const t = useT()
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
        <h1 className="text-2xl font-semibold">{t.canned.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.canned.lead}</p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          {t.canned.addAnswer}
        </Button>
      </div>

      {error && <MutationError message={error} />}

      {data.status === "pending" && <Skeleton className="h-40 w-full" />}
      {data.status === "error" && <MutationError message={data.message} />}

      {data.status === "success" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t.canned.count(rows.length)}
              {draftCount > 0 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {t.canned.waitingApproval(draftCount)}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.canned.emptyStatic}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.canned.columnQuestion}</TableHead>
                      <TableHead>{t.canned.columnAnswer}</TableHead>
                      <TableHead>{t.canned.columnStatus}</TableHead>
                      <TableHead className="text-right">{t.canned.columnActions}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.question}</TableCell>
                        <TableCell className="max-w-md text-muted-foreground">{row.answer}</TableCell>
                        <TableCell>
                          {row.status === "approved" ? (
                            <Badge variant="secondary">{t.canned.live}</Badge>
                          ) : (
                            <Badge variant="outline">{t.canned.draftBadge}</Badge>
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
                              {row.status === "approved" ? t.canned.withdraw : t.canned.approve}
                            </Button>
                            <RowActions
                              label={t.common.actionsFor(row.question)}
                              actions={[
                                { label: t.common.edit, disabled: busy, onSelect: () => setEditing(row) },
                                {
                                  label: t.common.delete,
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
            title={t.canned.dialog.addTitle}
            description={t.canned.addDescription}
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
            submitLabel={t.canned.dialog.addAndApprove}
          />
        )}
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <AnswerDialog
            title={t.canned.dialog.editTitle}
            description={t.canned.editDescription}
            busy={busy}
            initial={{ question: editing.question, answer: editing.answer }}
            submitLabel={t.canned.dialog.addAsDraft}
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
        title={t.canned.deleteTitle(pendingDelete?.question ?? "")}
        description={t.canned.deleteDescription}
        confirmLabel={t.canned.deleteAnswer}
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
  const t = useT()
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
          <Label htmlFor="canned-question">{t.canned.questionLabel}</Label>
          <Input
            id="canned-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t.canned.questionPlaceholder}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="canned-answer">{t.canned.answerLabel}</Label>
          <Textarea
            id="canned-answer"
            rows={4}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t.canned.answerPlaceholder}
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
