import * as React from "react"
import { Check, Copy } from "lucide-react"
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
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { RowActions } from "../components/row-actions"
import { Skeleton } from "../components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table"
import { useFetch } from "../hooks/use-fetch"
import { formatDateTime } from "../lib/format"
import { useT } from "../i18n"
import { api, type ChannelForm, type ChannelId, type ChannelsResponse } from "../lib/api"

/**
 * Channels — connecting WhatsApp, Telegram or Discord without touching the environment.
 *
 * Credentials are write-only by design. Nothing here ever displays a stored value, because there
 * is no use for it: a business either replaces a token or leaves it alone, and a field that shows
 * part of one is a field that leaks part of one. What the screen shows instead is which fields are
 * stored, which is what "connected" actually means.
 *
 * This was eight stacked cards, each with every credential box open at once — around twenty empty
 * password fields on a page where a shop connects one channel and never looks at the rest. It is a
 * table now, and the fields are behind the row's own dialog.
 *
 * Environment variables still work and still lose: a stored credential takes precedence, so a
 * shared installation does not answer every business's customers from one account.
 */
export function ChannelsPage({ tenantSlug }: { tenantSlug: string }) {
  const t = useT()
  const [reloadKey, setReloadKey] = React.useState(0)
  const data = useFetch(() => api.listChannels(tenantSlug), [tenantSlug, reloadKey])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [connecting, setConnecting] = React.useState<ChannelForm | null>(null)
  const [disconnecting, setDisconnecting] = React.useState<ChannelForm | null>(null)

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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t.channels.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.channels.description}</p>
      </div>

      {error && <MutationError message={error} />}
      {data.status === "pending" && <Skeleton className="h-48 w-full" />}
      {data.status === "error" && <MutationError message={data.message} />}

      {data.status === "success" && (
        <>
          {!data.data.secretKeyConfigured && (
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="text-base">{t.channels.noKeyTitle}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {t.channels.noKeyBody("openssl rand -base64 32")}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.channels.columnChannel}</TableHead>
                    <TableHead className="whitespace-nowrap">{t.channels.columnStatus}</TableHead>
                    <TableHead className="hidden md:table-cell">{t.channels.columnStored}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.forms.map((form) => {
                    const status = data.data.channels.find((c) => c.channel === form.id)
                    const locked = busy || !data.data.secretKeyConfigured
                    return (
                      <TableRow key={form.id}>
                        <TableCell>
                          <p className="font-medium">{form.title}</p>
                          <p className="text-xs text-muted-foreground">{form.hint}</p>
                          {status?.error && (
                            <p className="mt-1 text-xs text-destructive">{status.error}</p>
                          )}
                        </TableCell>
                        {/* Nowrap, because "Not connected" broke across two lines in this column
                            and a badge folded in half reads as a rendering fault. */}
                        <TableCell className="whitespace-nowrap">
                          {status ? (
                            <Badge variant={status.enabled ? "secondary" : "outline"}>
                              {status.enabled ? t.channels.connected : t.channels.paused}
                            </Badge>
                          ) : (
                            <Badge variant="outline">{t.channels.notConnected}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                          {status
                            ? `${
                                status.configuredFields
                                  .map(
                                    (name) =>
                                      form.fields.find((f) => f.name === name)?.label ?? name,
                                  )
                                  .join(", ") || t.common.nothing
                              }${status.updatedAt ? ` · ${formatDateTime(status.updatedAt)}` : ""}`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <RowActions
                            label={t.common.actionsFor(form.title)}
                            actions={[
                              {
                                label: status ? t.channels.replace : t.channels.connect,
                                disabled: locked,
                                onSelect: () => setConnecting(form),
                              },
                              ...(status
                                ? [
                                    {
                                      label: status.enabled ? t.channels.pause : t.channels.resume,
                                      disabled: busy,
                                      onSelect: () =>
                                        void act(() =>
                                          api.setChannelEnabled({
                                            tenantSlug,
                                            channel: form.id as ChannelId,
                                            enabled: !status.enabled,
                                          }),
                                        ),
                                    },
                                    {
                                      label: t.channels.disconnect,
                                      destructive: true,
                                      disabled: busy,
                                      onSelect: () => setDisconnecting(form),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={connecting !== null} onOpenChange={(open) => !open && setConnecting(null)}>
        {connecting && data.status === "success" && (
          <ConnectDialog
            form={connecting}
            data={data.data}
            tenantSlug={tenantSlug}
            busy={busy}
            onSave={async (secrets) => {
              const ok = await act(() =>
                api.saveChannel({
                  tenantSlug,
                  channel: connecting.id as ChannelId,
                  enabled: true,
                  secrets,
                }),
              )
              if (ok) setConnecting(null)
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={disconnecting !== null}
        title={t.channels.disconnectTitle(disconnecting?.title ?? "")}
        description={t.channels.disconnectDescription}
        confirmLabel={t.channels.disconnectConfirm}
        busy={busy}
        onCancel={() => setDisconnecting(null)}
        onConfirm={() => {
          const target = disconnecting
          if (!target) return
          void act(async () => {
            await api.deleteChannel({ tenantSlug, channel: target.id as ChannelId })
            setDisconnecting(null)
          })
        }}
      />
    </div>
  )
}

/**
 * The address the platform sends messages to.
 *
 * Copying it is the single most-repeated action on this screen, and the clipboard API is not
 * available at all over plain HTTP — which is how a self-hosted server is first reached, by IP,
 * before anyone has a certificate. So the URL is always shown as selectable text, and the button
 * falls back to the old copy command rather than failing silently.
 */
function WebhookUrl({ url }: { url: string }): React.ReactElement {
  const t = useT()
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        const area = document.createElement("textarea")
        area.value = url
        area.style.position = "fixed"
        area.style.opacity = "0"
        document.body.appendChild(area)
        area.select()
        document.execCommand("copy")
        area.remove()
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Nothing to report: the address is on screen and can be selected by hand.
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
      <code className="min-w-0 flex-1 break-all text-xs">{url}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={t.channels.copyAddress}
        onClick={() => void copy()}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}

function ConnectDialog({
  form,
  data,
  tenantSlug,
  busy,
  onSave,
}: {
  form: ChannelForm
  data: ChannelsResponse
  tenantSlug: string
  busy: boolean
  onSave: (secrets: Record<string, string>) => void
}): React.ReactElement {
  const t = useT()
  const status = data.channels.find((c) => c.channel === form.id)
  const [values, setValues] = React.useState<Record<string, string>>({})
  const requiredFields = form.fields.filter((f) => f.required)
  const missing = requiredFields.filter((f) => (values[f.name] ?? "").trim() === "")

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {status ? t.channels.dialogReplace(form.title) : t.channels.dialogConnect(form.title)}
        </DialogTitle>
        <DialogDescription>{form.hint}</DialogDescription>
      </DialogHeader>

      <div className="space-y-1">
        <Label>{t.channels.pointAt(form.title)}</Label>
        <WebhookUrl url={`${window.location.origin}/v1/channels/${form.id}/${tenantSlug}`} />
      </div>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(values)
          // Cleared on save because nothing here is ever read back: leaving a token in the form
          // would be the one place in the product that shows a stored credential.
          setValues({})
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {form.fields.map((field) => (
            <div key={field.name} className="space-y-1">
              <Label htmlFor={`${form.id}-${field.name}`}>
                {field.label}
                {!field.required && (
                  <span className="ml-1 text-xs text-muted-foreground">({t.common.optional})</span>
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
                  status?.configuredFields.includes(field.name) ? t.channels.stored : ""
                }
              />
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">{t.channels.secretHint}</p>

        <DialogFooter>
          <Button type="submit" disabled={busy || missing.length > 0}>
            {status ? t.channels.replace : t.channels.connect}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
