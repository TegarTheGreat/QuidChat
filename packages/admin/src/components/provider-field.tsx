import * as React from "react"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { api, type ProvidersResponse } from "../lib/api"
import { useFetch } from "../hooks/use-fetch"

/**
 * Where a business gives its assistant a model.
 *
 * This was the one step it could not do for itself: an operator had to set an environment variable
 * and restart the process. It is also the step without which nothing works at all, so a shop that
 * had done everything else correctly still had an assistant that refused every question, and
 * nothing in the panel said why.
 *
 * Only the common few are offered. Fourteen presets is the right number for a resolver and the
 * wrong number for a form — the shortest path from "I have a key" to "it answers" matters more
 * here than covering every vendor, and anything not listed still works through the environment.
 */

const OFFERED = [
  { name: "OPENAI_API_KEY", label: "OpenAI", hint: "sk-…, from platform.openai.com" },
  { name: "GROQ_API_KEY", label: "Groq", hint: "gsk_…, free tier available" },
  { name: "GEMINI_API_KEY", label: "Google Gemini", hint: "from aistudio.google.com" },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic", hint: "sk-ant-…" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter", hint: "sk-or-…, one key for many models" },
  {
    name: "OLLAMA_BASE_URL",
    label: "Ollama (on your own machine)",
    hint: "http://localhost:11434/v1 — no key needed, and nothing leaves your server",
  },
]

export function ProviderField({ tenantSlug }: { tenantSlug: string }): React.ReactElement {
  const [reloadKey, setReloadKey] = React.useState(0)
  const state = useFetch<ProvidersResponse>(
    () => api.getProviders(tenantSlug),
    [tenantSlug, reloadKey],
  )
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (state.status !== "success") {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  const data = state.data

  async function save(next: Record<string, string>) {
    setBusy(true)
    setError(null)
    try {
      await api.saveProviders({ tenantSlug, secrets: next })
      setValues({})
      setReloadKey((k) => k + 1)
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
          This deployment has no <code>QUIDCHAT_SECRET_KEY</code>, so credentials cannot be stored
          safely yet. Generate one with <code>openssl rand -base64 32</code> and restart.
        </p>
      )}

      {data.configuredFields.length > 0 ? (
        <p className="text-sm">
          Answering with your own key:{" "}
          <span className="font-medium">
            {data.configuredFields
              .map((f) => OFFERED.find((o) => o.name === f)?.label ?? f)
              .join(", ")}
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Using whatever this server was started with. Paste a key below to bill your own account.
        </p>
      )}

      <div className="space-y-3">
        {OFFERED.map((option) => (
          <div key={option.name} className="space-y-1">
            <Label htmlFor={`provider-${option.name}`}>{option.label}</Label>
            <Input
              id={`provider-${option.name}`}
              type={option.name.endsWith("_BASE_URL") ? "text" : "password"}
              autoComplete="off"
              disabled={!data.secretKeyConfigured || busy}
              value={values[option.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [option.name]: e.target.value }))}
              placeholder={
                data.configuredFields.includes(option.name) ? "stored — type to replace" : option.hint
              }
            />
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !data.secretKeyConfigured || Object.values(values).every((v) => v.trim() === "")}
          onClick={() => void save(values)}
        >
          Save key
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
            Use this server's provider instead
          </Button>
        )}
      </div>
    </div>
  )
}
