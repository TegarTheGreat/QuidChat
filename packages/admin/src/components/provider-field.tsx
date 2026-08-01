import * as React from "react"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"
import { api, type ProvidersResponse } from "../lib/api"
import { useFetch } from "../hooks/use-fetch"
import { useT } from "../i18n"

/**
 * Where a business gives its assistant a model.
 *
 * This was the one step it could not do for itself: an operator had to set an environment variable
 * and restart the process. It is also the step without which nothing works at all, so a shop that
 * had done everything else correctly still had an assistant that refused every question, and
 * nothing in the panel said why.
 *
 * One provider at a time, chosen from a list. It used to be six credential boxes open at once —
 * a column of empty password fields, five of which nobody was going to fill in, pushing the save
 * button off the bottom of the dialog. A shop picks one provider and pastes one key.
 *
 * Only the common few are offered. Fourteen presets is the right number for a resolver and the
 * wrong number for a form: the shortest path from "I have a key" to "it answers" matters more
 * here than covering every vendor, and anything not listed still works through the environment.
 */

type Offered = {
  name: string
  label: string
  hint: string
  /** Where the key comes from, said plainly enough to follow without a tab open. */
  where: string
}

const OFFERED: Offered[] = [
  {
    name: "OPENAI_API_KEY",
    label: "OpenAI",
    hint: "sk-…",
    where: "platform.openai.com → API keys",
  },
  {
    name: "GROQ_API_KEY",
    label: "Groq",
    hint: "gsk_…",
    where: "console.groq.com → API keys. Has a free tier, and is the fastest of these.",
  },
  {
    name: "GEMINI_API_KEY",
    label: "Google Gemini",
    hint: "AIza…",
    where: "aistudio.google.com → Get API key. Has a free tier.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    hint: "sk-ant-…",
    where: "console.anthropic.com → API keys",
  },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    hint: "sk-or-…",
    where: "openrouter.ai → Keys. One key reaches models from every vendor above.",
  },
  {
    name: "OLLAMA_BASE_URL",
    label: "Ollama, on your own machine",
    hint: "http://localhost:11434/v1",
    where: "No key and no account. Nothing leaves your server, and it costs nothing to run.",
  },
]

function labelFor(field: string): string {
  return OFFERED.find((o) => o.name === field)?.label ?? field
}

export function ProviderField({
  tenantSlug,
  onSaved,
}: {
  tenantSlug: string
  /** So the model lists above refresh against the key just saved, without a reload. */
  onSaved?: () => void
}): React.ReactElement {
  const t = useT()
  const [reloadKey, setReloadKey] = React.useState(0)
  const state = useFetch<ProvidersResponse>(
    () => api.getProviders(tenantSlug),
    [tenantSlug, reloadKey],
  )
  const [choice, setChoice] = React.useState<string>(OFFERED[0]!.name)
  const [value, setValue] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (state.status !== "success") {
    return <p className="text-sm text-muted-foreground">{t.common.loading}</p>
  }
  const data = state.data
  const selected = OFFERED.find((o) => o.name === choice) ?? OFFERED[0]!
  const isUrl = selected.name.endsWith("_BASE_URL")

  async function save(next: Record<string, string>) {
    setBusy(true)
    setError(null)
    try {
      await api.saveProviders({ tenantSlug, secrets: next })
      setValue("")
      setReloadKey((k) => k + 1)
      onSaved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {!data.secretKeyConfigured && (
        // Saying this before they type beats a form whose every save fails, which reads as the
        // form being broken rather than as the deployment missing one variable.
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {t.settings.provider.noSecretKey}
        </p>
      )}

      {data.configuredFields.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t.settings.provider.usingOwn}</span>
          {data.configuredFields.map((field) => (
            <Badge key={field} variant="secondary" className="gap-1 pr-1">
              {labelFor(field)}
              <button
                type="button"
                aria-label={t.settings.provider.remove(labelFor(field))}
                disabled={busy}
                // An empty value removes exactly this one and leaves the rest, which matters when
                // a shop answers with one provider and searches with another.
                onClick={() => void save({ [field]: "" })}
                className="rounded-sm px-1 leading-none hover:bg-background"
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t.settings.provider.usingServer}</p>
      )}

      {data.localRunner?.available && data.configuredFields.length === 0 && (
        // The answer to "I have no card and no key", which for a small shop is not an edge case
        // but the first sentence of the conversation. It was reachable only by setting an
        // environment variable, so the deployments most likely to have a runner going were the
        // least likely to be told.
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <p className="text-sm">
            {t.settings.provider.localRunner(
              data.localRunner.models.slice(0, 3).join(", "),
              data.localRunner.models.length > 3,
            )}
          </p>
          <Button
            size="sm"
            disabled={busy || !data.secretKeyConfigured}
            onClick={() =>
              void save({ OLLAMA_BASE_URL: data.localRunnerUrl ?? "http://127.0.0.1:11434/v1" })
            }
          >
            {t.settings.provider.useLocalRunner}
          </Button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <div className="space-y-1">
          <Label htmlFor="provider-choice">{t.settings.provider.providerLabel}</Label>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger id="provider-choice" disabled={!data.secretKeyConfigured || busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OFFERED.map((option) => (
                <SelectItem key={option.name} value={option.name}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="provider-secret">
            {isUrl ? t.settings.provider.addressLabel : t.settings.provider.keyLabel}
          </Label>
          <Input
            id="provider-secret"
            // A key is hidden; an address is not. Masking something that is not a secret only
            // makes it harder to check for a typo.
            type={isUrl ? "text" : "password"}
            autoComplete="off"
            disabled={!data.secretKeyConfigured || busy}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              data.configuredFields.includes(selected.name)
                ? t.settings.provider.stored
                : selected.hint
            }
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t.settings.provider.where[selected.name] ?? selected.where}
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !data.secretKeyConfigured || value.trim() === ""}
          onClick={() => void save({ [selected.name]: value.trim() })}
        >
          {busy ? t.common.saving : t.settings.provider.use(selected.label)}
        </Button>
        {data.configuredFields.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            // Back to the server's own provider, rather than to nothing — an assistant that
            // stops answering entirely is not what "remove my key" should mean.
            onClick={() => void save({})}
          >
            {t.settings.provider.useServer}
          </Button>
        )}
      </div>
    </div>
  )
}
