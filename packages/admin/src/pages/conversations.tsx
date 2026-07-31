import * as React from "react"
import { ArrowLeft, FileText } from "lucide-react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { ConfirmDialog } from "../components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { RowActions } from "../components/row-actions"
import { ScrollArea } from "../components/ui/scroll-area"
import { Skeleton } from "../components/ui/skeleton"
import { Textarea } from "../components/ui/textarea"
import { cn } from "../lib/utils"
import { useFetch } from "../hooks/use-fetch"
import { formatDateTime } from "../lib/format"
import { api, type Conversation, type ConversationMessage } from "../lib/api"

/** The question an answer replied to — the nearest customer message before it. */
function questionBefore(messages: ConversationMessage[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const candidate = messages[i]
    if (candidate?.role === "user") return candidate.content
  }
  return ""
}

function conversationLabel(conversation: Conversation): string {
  // The list endpoint carries no message text, so the label is what identifies a visitor and
  // when they came. Loading fifty transcripts to print a first line would cost a payload that
  // grows with traffic for something the reader mostly skips past.
  const channel = conversation.channel ?? "web"
  const visitor = conversation.visitorId ?? "unknown"
  return `${channel} · ${visitor}`
}

/**
 * Conversations — the list on the left, one transcript on the right.
 *
 * The transcript is fetched when a conversation is selected rather than shipped with the list.
 * That is not only about payload size: this screen is where an owner judges whether the assistant
 * is doing its job, and what makes that judgement possible is each answer's citations and the
 * skill that produced it — per-message detail that has no business being multiplied by fifty rows
 * nobody opened.
 *
 * Reading was all it allowed. The two things an owner wants to do while reading are to write the
 * answer the assistant did not have, and to erase a transcript a customer has asked them to
 * erase; both meant leaving this screen, and the second meant SQL. They are here now, on the
 * message and on the conversation.
 */
export function ConversationsPage({ tenantSlug }: { tenantSlug: string }) {
  const [reloadKey, setReloadKey] = React.useState(0)
  const conversations = useFetch(() => api.listConversations(tenantSlug), [tenantSlug, reloadKey])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<Conversation | null>(null)
  const [saving, setSaving] = React.useState<{ question: string; answer: string } | null>(null)

  const activeId =
    selectedId ?? (conversations.status === "success" ? (conversations.data[0]?.id ?? null) : null)

  const transcript = useFetch(
    () => (activeId ? api.getConversation(tenantSlug, activeId) : Promise.resolve(null)),
    [tenantSlug, activeId],
  )

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Conversations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What your customers asked and what the assistant said back, with the document behind
            every claim it made about your business.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
          Refresh
        </Button>
      </div>

      {error && <MutationError message={error} />}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      {conversations.status === "pending" && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {conversations.status === "error" && <MutationError message={conversations.message} />}

      {conversations.status === "success" && (
        <div className="flex h-[600px] overflow-hidden rounded-lg border">
          {/* On a phone the two panes cannot both fit, so the list gives way to the transcript
              once one is chosen and a back button brings it back. Two 150px columns side by side
              is not a smaller version of this screen, it is an unusable one. */}
          <div
            className={cn(
              "w-full shrink-0 border-r sm:w-72",
              activeId ? "hidden sm:block" : "block",
            )}
          >
            <ScrollArea className="h-full">
              {conversations.data.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">
                  No conversations yet. They appear here as soon as someone asks the widget
                  something.
                </p>
              )}
              {conversations.data.map((conversation) => (
                <div
                  key={conversation.id}
                  className={cn(
                    "flex items-center gap-1 border-b pr-1 last:border-b-0 hover:bg-accent",
                    activeId === conversation.id && "bg-accent",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(conversation.id)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 p-3 text-left text-sm"
                  >
                    <span className="w-full truncate font-medium">
                      {conversationLabel(conversation)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {conversation.messageCount ?? 0} message
                      {conversation.messageCount === 1 ? "" : "s"}
                      {conversation.createdAt ? ` · ${formatDateTime(conversation.createdAt)}` : ""}
                    </span>
                  </button>
                  <RowActions
                    label={`Actions for the conversation with ${conversation.visitorId ?? "an unknown visitor"}`}
                    actions={[
                      {
                        label: "Delete transcript",
                        destructive: true,
                        disabled: busy,
                        onSelect: () => setDeleting(conversation),
                      },
                    ]}
                  />
                </div>
              ))}
            </ScrollArea>
          </div>

          <div className={cn("flex-1 overflow-hidden", activeId ? "block" : "hidden sm:block")}>
            <ScrollArea className="h-full p-4">
              {activeId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-2 -ml-2 sm:hidden"
                  onClick={() => setSelectedId(null)}
                >
                  <ArrowLeft className="size-4" /> All conversations
                </Button>
              )}
              {!activeId && <p className="text-sm text-muted-foreground">Select a conversation.</p>}
              {transcript.status === "pending" && activeId && (
                <div className="space-y-3">
                  <Skeleton className="h-16 w-2/3" />
                  <Skeleton className="ml-auto h-16 w-2/3" />
                </div>
              )}
              {transcript.status === "error" && <MutationError message={transcript.message} />}
              {transcript.status === "success" && transcript.data && (
                <div className="space-y-4">
                  {transcript.data.messages.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      This conversation has no messages recorded.
                    </p>
                  )}
                  {transcript.data.messages.map((message, index) => (
                    <div
                      key={message.id ?? index}
                      className={cn(
                        "group max-w-[80%] rounded-lg border p-3 text-sm",
                        message.role === "user"
                          ? "ml-auto bg-primary text-primary-foreground"
                          : "bg-muted",
                      )}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                      {(message.skillName ||
                        (message.citations && message.citations.length > 0)) && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {message.skillName && (
                            // A wrong answer and a wrongly-routed answer read identically
                            // without this, and they need different fixes: one is missing
                            // content, the other is a routing rule.
                            <Badge variant="secondary" className="text-xs font-normal">
                              {message.skillName}
                            </Badge>
                          )}
                          {message.citations?.map((citation) => (
                            <Badge
                              key={citation.sourceId}
                              variant="outline"
                              className="gap-1 text-xs font-normal"
                            >
                              <FileText className="size-3" />
                              {citation.title}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {message.role === "assistant" && (
                        // The action this screen was missing. Reading a bad answer and then
                        // navigating to Canned answers to retype the question from memory is how
                        // the fix does not get made.
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-7 px-2 text-xs"
                          onClick={() =>
                            setSaving({
                              question: questionBefore(transcript.data!.messages, index),
                              answer: message.content,
                            })
                          }
                        >
                          Write the answer for this
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      )}

      <Dialog open={saving !== null} onOpenChange={(open) => !open && setSaving(null)}>
        {saving && (
          <CannedFromTranscript
            initial={saving}
            busy={busy}
            onSave={async (question, answer, approved) => {
              const ok = await act(() =>
                api.createCannedAnswer({ tenantSlug, question, answer, approved }),
              )
              if (!ok) return
              setSaving(null)
              setNotice(
                approved
                  ? "Saved. That question is answered from your own words from now on."
                  : "Saved as a draft. It starts being used once you approve it on the Canned answers screen.",
              )
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the transcript with ${deleting?.visitorId ?? "this visitor"}?`}
        description="Every message in it goes, along with what the assistant cited and any escalation raised from it. This is what to use when a customer asks you to erase what you hold about them. What stays is this month's total spend, which carries no message text."
        confirmLabel="Delete it"
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting
          if (!target) return
          void act(async () => {
            await api.deleteConversation({ tenantSlug, id: target.id })
            setDeleting(null)
            if (activeId === target.id) setSelectedId(null)
            setReloadKey((k) => k + 1)
          })
        }}
      />
    </div>
  )
}

/**
 * Turning one exchange into a canned answer.
 *
 * Both fields arrive filled in — the customer's question as they asked it, and what the assistant
 * said — and both are editable, because the point is usually that the answer was wrong. Keeping
 * the question verbatim matters: it is the phrasing real customers use, not the phrasing a shop
 * owner would have guessed.
 */
function CannedFromTranscript({
  initial,
  busy,
  onSave,
}: {
  initial: { question: string; answer: string }
  busy: boolean
  onSave: (question: string, answer: string, approved: boolean) => void
}): React.ReactElement {
  const [question, setQuestion] = React.useState(initial.question)
  const [answer, setAnswer] = React.useState(initial.answer)

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Write the answer for this question</DialogTitle>
        <DialogDescription>
          A canned answer is used word for word, ahead of anything the assistant would compose. Use
          it where the wording has to be exact.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="from-transcript-question">Question</Label>
          <Input
            id="from-transcript-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Apakah bisa COD?"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="from-transcript-answer">Answer</Label>
          <Textarea
            id="from-transcript-answer"
            rows={5}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            This is what the assistant said. Correct it — that is usually why you are here.
          </p>
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          disabled={busy || question.trim() === "" || answer.trim() === ""}
          onClick={() => onSave(question.trim(), answer.trim(), false)}
        >
          Save as draft
        </Button>
        <Button
          disabled={busy || question.trim() === "" || answer.trim() === ""}
          onClick={() => onSave(question.trim(), answer.trim(), true)}
        >
          Save and use it
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
