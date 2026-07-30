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
import { api, type ChannelId, type ChannelsResponse } from "../lib/api"

/** Plain names, and the webhook path each platform has to be pointed at — the one thing an
 *  owner cannot work out from the form alone. */
const CHANNELS: { id: ChannelId; title: string; hint: string }[] = [
  { id: "telegram", title: "Telegram", hint: "Create a bot with @BotFather, then set its webhook to the URL below." },
  { id: "whatsapp", title: "WhatsApp (Cloud API)", hint: "From Meta's WhatsApp Business setup: the phone number id and a permanent access token." },
  { id: "waha", title: "WhatsApp (self-hosted WAHA)", hint: "The address of your own WAHA server." },
  { id: "discord", title: "Discord", hint: "From your Discord application: the bot token and its public key." },
]

/** Human labels for credential fields, so a form does not read like a database. */
const FIELD_LABELS: Record<string, string> = {
  botToken: "Bot token",
  secretToken: "Webhook secret",
  phoneNumberId: "Phone number ID",
  accessToken: "Access token",
  appSecret: "App secret",
  baseUrl: "Server address",
  session: "Session name",
  apiKey: "API key",
  publicKey: "Public key",
}

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

          {CHANNELS.map((channel) => (
            <ChannelCard
              key={channel.id}
              tenantSlug={tenantSlug}
              meta={channel}
              data={data.data}
              busy={busy || !data.data.secretKeyConfigured}
              onSave={(secrets, enabled) =>
                act(() => api.saveChannel({ tenantSlug, channel: channel.id, enabled, secrets }))
              }
              onDisconnect={() => act(() => api.deleteChannel({ tenantSlug, channel: channel.id }))}
            />
          ))}
        </>
      )}
    </div>
  )
}

function ChannelCard({
  tenantSlug,
  meta,
  data,
  busy,
  onSave,
  onDisconnect,
}: {
  tenantSlug: string
  meta: { id: ChannelId; title: string; hint: string }
  data: ChannelsResponse
  busy: boolean
  onSave: (secrets: Record<string, string>, enabled: boolean) => void
  onDisconnect: () => void
}) {
  const spec = data.fields[meta.id] ?? { required: [], optional: [] }
  const status = data.channels.find((c) => c.channel === meta.id)
  const [values, setValues] = React.useState<Record<string, string>>({})

  const allFields = [...spec.required, ...spec.optional]
  const missingRequired = spec.required.filter((f) => (values[f] ?? "").trim() === "")

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
              Stored: {status.configuredFields.map((f) => FIELD_LABELS[f] ?? f).join(", ") || "nothing"}
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
              <div key={field} className="space-y-1">
                <Label htmlFor={`${meta.id}-${field}`}>
                  {FIELD_LABELS[field] ?? field}
                  {spec.optional.includes(field) && (
                    <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
                  )}
                </Label>
                <Input
                  id={`${meta.id}-${field}`}
                  // A password field, not because it is a password, but because a browser
                  // should not offer to remember it and a shoulder should not read it.
                  type={field === "baseUrl" || field === "session" ? "text" : "password"}
                  autoComplete="off"
                  value={values[field] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                  placeholder={status?.configuredFields.includes(field) ? "stored — type to replace" : ""}
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
          {spec.required.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {spec.required.map((f) => FIELD_LABELS[f] ?? f).join(" and ")}{" "}
              {spec.required.length === 1 ? "is" : "are"} required. Set the
              webhook secret too where the platform offers one: without it, anyone who learns the
              URL above can put words in your conversation history and spend your budget.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  )
}
