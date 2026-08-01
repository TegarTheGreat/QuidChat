import * as React from "react"
import { Button } from "./ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { Input } from "./ui/input"
import { MutationError } from "./mutation-error"
import { useT } from "../i18n"
import { api, type SetupChatReply } from "../lib/api"
import { cn } from "../lib/utils"

/**
 * Asking about your own setup, in words.
 *
 * The route and the agent behind this have existed for a while with nothing calling them: a
 * capability that shipped, cost tokens to build, and could not be reached from anywhere in the
 * product. This is the reaching.
 *
 * It answers from tools rather than from memory — it runs the same diagnostics the cards above
 * are built from, counts what is indexed, and explains a setting in this version's own words. The
 * server offers it exactly the tools it can run, so it never proposes something and then reports
 * that it could not.
 *
 * Three questions are offered to start with, because "ask me anything about your setup" is the
 * same empty box the widget had before it was given something to say.
 */
type Turn = { role: "user" | "assistant"; content: string; ran?: string[] }

export function SetupAssistant({ tenantId }: { tenantId: string }): React.ReactElement {
  const t = useT()
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState<SetupChatReply["pending"]>(undefined)

  async function ask(message: string): Promise<void> {
    if (message.trim() === "" || busy) return
    setBusy(true)
    setError(null)
    setPending(undefined)
    const history = turns.map((turn) => ({ role: turn.role, content: turn.content }))
    setTurns((prev) => [...prev, { role: "user", content: message }])
    setDraft("")
    try {
      const reply = await api.setupChat({ tenantId, message, history })
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: reply.text, ...(reply.ran?.length ? { ran: reply.ran } : {}) },
      ])
      if (reply.kind === "needs_confirmation") setPending(reply.pending)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      const reply = await api.setupChat({
        tenantId,
        message: "confirmed",
        confirm: { call: pending.call, confirmed: true },
      })
      setTurns((prev) => [...prev, { role: "assistant", content: reply.text }])
      setPending(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t.setup.assistant.title}</CardTitle>
        <p className="text-sm text-muted-foreground">{t.setup.assistant.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {turns.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {t.setup.assistant.openers.map((question) => (
              <Button
                key={question}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void ask(question)}
              >
                {question}
              </Button>
            ))}
          </div>
        )}

        {turns.length > 0 && (
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {turns.map((turn, index) => (
              <div
                key={index}
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  turn.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "border bg-muted/40",
                )}
              >
                <p className="whitespace-pre-wrap">{turn.content}</p>
                {turn.ran && turn.ran.length > 0 && (
                  // What it actually did, not only what it says it did. An assistant that claims
                  // to have checked something is worth less than one that shows the check.
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.setup.assistant.checked(turn.ran.join(", "))}
                  </p>
                )}
              </div>
            ))}
            {busy && <p className="text-sm text-muted-foreground">{t.setup.assistant.checking}</p>}
          </div>
        )}

        {error && <MutationError message={error} />}

        {pending && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="text-sm">{pending.summary}</p>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void confirmPending()}>
                {t.setup.assistant.doIt}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setPending(undefined)}
              >
                {t.setup.assistant.leaveIt}
              </Button>
            </div>
          </div>
        )}

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void ask(draft)
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t.setup.assistant.placeholder}
            aria-label={t.setup.assistant.inputLabel}
            disabled={busy}
          />
          <Button type="submit" disabled={busy || draft.trim() === ""}>
            {t.setup.assistant.ask}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
