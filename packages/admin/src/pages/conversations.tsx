import * as React from "react"
import { FileText } from "lucide-react"
import { Badge } from "../components/ui/badge"
import { MutationError } from "../components/mutation-error"
import { ScrollArea } from "../components/ui/scroll-area"
import { Skeleton } from "../components/ui/skeleton"
import { cn } from "../lib/utils"
import { useFetch } from "../hooks/use-fetch"
import { formatDateTime } from "../lib/format"
import { api, type Conversation } from "../lib/api"

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
 * That is not only about payload size: this screen is where an owner judges whether the
 * assistant is doing its job, and what makes that judgement possible is each answer's
 * citations and the skill that produced it — per-message detail that has no business being
 * multiplied by fifty rows nobody opened.
 */
export function ConversationsPage({ tenantSlug }: { tenantSlug: string }) {
  const conversations = useFetch(() => api.listConversations(tenantSlug), [tenantSlug])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  const activeId =
    selectedId ?? (conversations.status === "success" ? conversations.data[0]?.id ?? null : null)

  const transcript = useFetch(
    () =>
      activeId
        ? api.getConversation(tenantSlug, activeId)
        : Promise.resolve(null),
    [tenantSlug, activeId],
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Conversations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What your customers asked and what the assistant said back, with the document behind
          every claim it made about your business.
        </p>
      </div>

      {conversations.status === "pending" && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {conversations.status === "error" && <MutationError message={conversations.message} />}

      {conversations.status === "success" && (
        <div className="flex h-[600px] overflow-hidden rounded-lg border">
          <div className="w-72 shrink-0 border-r">
            <ScrollArea className="h-full">
              {conversations.data.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">No conversations yet.</p>
              )}
              {conversations.data.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => setSelectedId(conversation.id)}
                  className={cn(
                    "flex w-full flex-col items-start gap-1 border-b p-3 text-left text-sm last:border-b-0 hover:bg-accent",
                    activeId === conversation.id && "bg-accent",
                  )}
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
              ))}
            </ScrollArea>
          </div>

          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full p-4">
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
                        "max-w-[80%] rounded-lg border p-3 text-sm",
                        message.role === "user"
                          ? "ml-auto bg-primary text-primary-foreground"
                          : "bg-muted",
                      )}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                      {(message.skillName || (message.citations && message.citations.length > 0)) && (
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
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  )
}
