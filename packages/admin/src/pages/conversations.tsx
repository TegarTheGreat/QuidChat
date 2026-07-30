import * as React from "react"
import { FileText } from "lucide-react"
import { Badge } from "../components/ui/badge"
import { MutationError } from "../components/mutation-error"
import { ScrollArea } from "../components/ui/scroll-area"
import { Skeleton } from "../components/ui/skeleton"
import { cn } from "../lib/utils"
import { useFetch } from "../hooks/use-fetch"
import { api, type Conversation } from "../lib/api"

function conversationLabel(conversation: Conversation): string {
  const firstUserMessage = conversation.messages.find((m) => m.role === "user")
  return firstUserMessage?.content.slice(0, 60) || conversation.id
}

/** List on the left, transcript on the right — the nested master-detail view
 *  requested for conversations. Each assistant reply shows which document it
 *  cited, since that is the product's core promise made visible here. */
export function ConversationsPage({ tenantSlug }: { tenantSlug: string }) {
  const conversations = useFetch(() => api.listConversations(tenantSlug), [tenantSlug])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  const selected =
    conversations.status === "success"
      ? conversations.data.find((c) => c.id === selectedId) ?? conversations.data[0] ?? null
      : null

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Conversations</h1>
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
                    "flex w-full flex-col items-start gap-1 whitespace-nowrap border-b p-3 text-left text-sm last:border-b-0 hover:bg-accent",
                    (selected?.id ?? conversations.data[0]?.id) === conversation.id && "bg-accent",
                  )}
                >
                  <span className="w-full truncate font-medium">
                    {conversationLabel(conversation)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {conversation.startedAt ?? conversation.id}
                  </span>
                </button>
              ))}
            </ScrollArea>
          </div>
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full p-4">
              {!selected && <p className="text-sm text-muted-foreground">Select a conversation.</p>}
              {selected && (
                <div className="space-y-4">
                  {selected.messages.map((message, index) => (
                    <div
                      key={message.id ?? index}
                      className={cn(
                        "max-w-[80%] rounded-lg border p-3 text-sm",
                        message.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted",
                      )}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                      {message.citations && message.citations.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {message.citations.map((citation) => (
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
