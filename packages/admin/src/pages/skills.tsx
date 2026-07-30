import * as React from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { Textarea } from "../components/ui/textarea"
import { useFetch } from "../hooks/use-fetch"
import { api, type RoutingRule, type Skill, type Source } from "../lib/api"

const KINDS = ["keyword", "fallback", "semantic", "llm"] as const

/** Rules for one skill, in evaluation order. First match wins, so any other order would
 *  misrepresent what actually happens at runtime. */
function rulesFor(skill: Skill, rules: RoutingRule[]): RoutingRule[] {
  return rules.filter((r) => r.skillId === skill.id).toSorted((a, b) => a.position - b.position)
}

/**
 * Skills and routing.
 *
 * Rules and skills are shown together because neither means anything alone: a skill with
 * no rule is unreachable, and a rule pointing at a disabled skill is skipped. An owner
 * asking "why did that question go there?" needs to see the order, the patterns and the
 * linked sources in one place.
 *
 * Rules are listed in evaluation order with the position visible, because first match wins
 * — a list sorted any other way would misrepresent what actually happens.
 */
export function SkillsPage({ tenantSlug }: { tenantSlug: string }) {
  const [reloadKey, setReloadKey] = React.useState(0)
  const data = useFetch(() => api.getSkills(tenantSlug), [tenantSlug, reloadKey])
  const sources = useFetch(() => api.listSources(tenantSlug), [tenantSlug, reloadKey])

  const [name, setName] = React.useState("")
  const [prompt, setPrompt] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const reload = () => setReloadKey((k) => k + 1)

  async function addSkill(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.createSkill({
        tenantSlug,
        name,
        ...(prompt.trim() ? { systemPrompt: prompt.trim() } : {}),
      })
      setName("")
      setPrompt("")
      reload()
    } catch (cause) {
      // The server's message names the problem — an empty name, an invalid mode. Replacing
      // it with "something went wrong" throws away the only useful part.
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Skills &amp; routing</h1>

      {error && <MutationError message={error} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a skill</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={addSkill} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="skill-name">Name</Label>
              <Input
                id="skill-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sales"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="skill-prompt">Extra instructions (optional)</Label>
              <Textarea
                id="skill-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Be brief and always mention delivery times."
              />
              <p className="text-xs text-muted-foreground">
                Added to the grounding rules, never in place of them — a skill sets voice
                and scope, not whether answers need a source.
              </p>
            </div>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "Saving…" : "Add skill"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {data.status === "pending" && <Skeleton className="h-32 w-full" />}
      {data.status === "error" && <MutationError message={data.message} />}

      {data.status === "success" && (
        <div className="space-y-4">
          {data.data.skills.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No skills yet. Without any, every question is answered from all of this
              tenant&rsquo;s documents — which is a sensible default, not a problem.
            </p>
          )}

          {data.data.skills.map((skill) => (
            <Card key={skill.id}>
              <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
                <div>
                  <CardTitle className="text-base">{skill.name}</CardTitle>
                  {skill.systemPrompt && (
                    <p className="mt-1 text-sm text-muted-foreground">{skill.systemPrompt}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  {skill.isFallback && <Badge variant="secondary">Handoff target</Badge>}
                  {!skill.enabled && <Badge variant="outline">Disabled</Badge>}
                  {skill.answerMode && <Badge variant="outline">{skill.answerMode}</Badge>}
                </div>
              </CardHeader>

              <CardContent className="space-y-4 text-sm">
                <div>
                  <p className="font-medium">Routing rules</p>
                  {rulesFor(skill, data.data.rules).length === 0 ? (
                    <p className="text-muted-foreground">
                      No rule points here, so this skill is never selected.
                    </p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {rulesFor(skill, data.data.rules).map((rule) => (
                        <li key={rule.id} className="flex items-center gap-2">
                          <Badge variant="outline">#{rule.position}</Badge>
                          <span>{rule.kind}</span>
                          {rule.pattern && (
                            <code className="rounded bg-muted px-1">{rule.pattern}</code>
                          )}
                          {!rule.enabled && <Badge variant="outline">off</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <RuleForm
                    disabled={busy}
                    onSubmit={(kind, pattern) =>
                      act(() =>
                        api.createRoutingRule({
                          tenantSlug,
                          skillId: skill.id,
                          kind,
                          ...(pattern ? { pattern } : {}),
                        }),
                      )
                    }
                  />
                </div>

                <div>
                  <p className="font-medium">Sources this skill may read</p>
                  {sources.status === "success" && sources.data.length === 0 && (
                    <p className="text-muted-foreground">No sources added yet.</p>
                  )}
                  {sources.status === "success" && sources.data.length > 0 && (
                    <ul className="mt-1 space-y-1">
                      {sources.data.map((source: Source) => {
                        const linked = skill.sources.some((s) => s.sourceId === source.id)
                        return (
                          <li key={source.id} className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant={linked ? "secondary" : "outline"}
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                act(() =>
                                  api.linkSkillSource({
                                    tenantSlug,
                                    skillId: skill.id,
                                    sourceId: source.id,
                                    linked: !linked,
                                  }),
                                )
                              }
                            >
                              {linked ? "Linked" : "Link"}
                            </Button>
                            <span className="text-muted-foreground">{source.title}</span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {skill.sources.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      With nothing linked, this skill reads all of the tenant&rsquo;s
                      documents rather than none — otherwise an unconfigured skill would
                      refuse every question.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function RuleForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean
  onSubmit: (kind: string, pattern: string) => void
}) {
  const [kind, setKind] = React.useState<string>("keyword")
  const [pattern, setPattern] = React.useState("")

  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(kind, pattern.trim())
        setPattern("")
      }}
    >
      <select
        aria-label="Rule kind"
        className="h-9 rounded-md border bg-background px-2 text-sm"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      {kind === "keyword" && (
        <Input
          aria-label="Keyword"
          className="w-40"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="price"
        />
      )}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={disabled || (kind === "keyword" && pattern.trim() === "")}
      >
        Add rule
      </Button>
    </form>
  )
}
