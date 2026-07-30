import * as React from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { useFetch } from "../hooks/use-fetch"
import { formatDateTime } from "../lib/format"
import { api, type ChannelForm, type ChannelId, type ChannelsResponse } from "../lib/api"

/**
 * Channels — connecting WhatsApp, Telegram or Discord without touching the environment.
 *
 * Credentials are write-only by design. Nothing here ever displays a stored value, because
 * there is no use for it: a business either replaces a token or leaves it alone, and a field
 * that shows part of one is a field that leaks part of one. What the screen shows instead is
 * which fields are stored, which is what "connected" actually means.
 *
 * Environment variables still work and still win nothing: a stored credential takes precedence,
 * so a shared installation stops answering every business's customers from one account.
 */
export function ChannelsPage({ tenantSlug }: { tenantSlug: string }) {
  const [reloadKey, setReloadKey] = React.useState(0)
  const data = useFetch(() => api.listChannels(tenantSlug), [tenantSlug, reloadKey])
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Channels</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The same assistant, answering on the places your customers already use. Every channel
          goes through the identical pipeline, so grounding, refusals and your budget behave
          exactly as they do on your website.
        </p>
      </div>

      {error && <MutationError message={error} />}
      {data.status === "pending" && <Skeleton className="h-48 w-full" />}
      {data.status === "error" && <MutationError message={data.message} />}

      {data.status === "success" && (
        <>
          {!data.data.secretKeyConfigured && (
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="text-base">Credentials cannot be stored yet</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Set <code className="rounded bg-muted px-1">QUIDCHAT_SECRET_KEY</code> on the
                server and restart it. Channel credentials are encrypted with it, and storing
                them in plain text is not offered as an alternative — a database backup would
                hand over the ability to send messages as your business. Generate one with{" "}
                <code className="rounded bg-muted px-1">openssl rand -base64 32</code>.
              </CardContent>
            </Card>
          )}

          {data.data.forms.map((form) => (
            <ChannelCard
              key={form.id}
              tenantSlug={tenantSlug}
              form={form}
              data={data.data}
              busy={busy || !data.data.secretKeyConfigured}
              onSave={(secrets, enabled) =>
                act(() =>
                  api.saveChannel({
                    tenantSlug,
                    channel: form.id as ChannelId,
                    enabled,
                    secrets,
                  }),
                )
              }
              onDisconnect={() =>
                act(() => api.deleteChannel({ tenantSlug, channel: form.id as ChannelId }))
              }
            />
          ))}
        </>
      )}
    </div>
  )
}

function ChannelCard({
  tenantSlug,
  form,
  data,
  busy,
  onSave,
  onDisconnect,
}: {
  tenantSlug: string
  form: ChannelForm
  data: ChannelsResponse
  busy: boolean
  onSave: (secrets: Record<string, string>, enabled: boolean) => void
  onDisconnect: () => void
}) {
  const meta = form
  const status = data.channels.find((c) => c.channel === form.id)
  const [values, setValues] = React.useState<Record<string, string>>({})

  const allFields = form.fields
  const requiredFields = form.fields.filter((f) => f.required)
  const missingRequired = requiredFields.filter((f) => (values[f.name] ?? "").trim() === "")

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">{meta.title}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{meta.hint}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {status ? (
            <Badge variant={status.enabled ? "secondary" : "outline"}>
              {status.enabled ? "Connected" : "Paused"}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {status?.error && <MutationError message={status.error} />}

        <div className="space-y-1">
          {status && (
            <p className="text-muted-foreground">
              Stored:{" "}
              {status.configuredFields
                .map((name) => form.fields.find((f) => f.name === name)?.label ?? name)
                .join(", ") || "nothing"}
              {status.updatedAt ? ` · updated ${formatDateTime(status.updatedAt)}` : ""}
            </p>
          )}
          {/* Shown before connecting as well as after. This URL is what someone pastes into
              BotFather or Meta's console, and needing it is the reason they opened this card —
              hiding it until the channel is already connected has the order backwards. */}
          <p className="text-xs text-muted-foreground">
            Point {meta.title} at{" "}
            <code className="rounded bg-muted px-1">
              {`${window.location.origin}/v1/channels/${meta.id}/${tenantSlug}`}
            </code>
          </p>
        </div>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            onSave(values, true)
            // Cleared on save because nothing here is ever read back: leaving a token visible in
            // the form would be the one place in the product that shows a stored credential.
            setValues({})
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {allFields.map((field) => (
              <div key={field.name} className="space-y-1">
                <Label htmlFor={`${form.id}-${field.name}`}>
                  {field.label}
                  {!field.required && (
                    <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
                  )}
                </Label>
                <Input
                  id={`${form.id}-${field.name}`}
                  // Hidden for a credential, plain for an address or a session name: masking
                  // something that is not a secret only makes it harder to check.
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                  placeholder={
                    status?.configuredFields.includes(field.name) ? "stored — type to replace" : ""
                  }
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || missingRequired.length > 0}>
              {status ? "Replace credentials" : "Connect"}
            </Button>
            {status && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  // Pausing needs the credentials again, because the API replaces the row rather
                  // than patching it. Asking for them is more honest than a toggle that appears
                  // to work and silently keeps the old ones.
                  onClick={() => onDisconnect()}
                >
                  Disconnect
                </Button>
              </>
            )}
          </div>
          {requiredFields.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {requiredFields.map((f) => f.label).join(" and ")}{" "}
              {requiredFields.length === 1 ? "is" : "are"} required. Set the
              webhook secret too where the platform offers one: without it, anyone who learns the
              URL above can put words in your conversation history and spend your budget.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  )
}
