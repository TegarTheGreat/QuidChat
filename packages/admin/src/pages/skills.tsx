import * as React from "react"
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
import { RoutingGraph } from "../components/routing-graph"
import { RowActions } from "../components/row-actions"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select"
import { Skeleton } from "../components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table"
import { Textarea } from "../components/ui/textarea"
import { useFetch } from "../hooks/use-fetch"
import { useT } from "../i18n"
import { api, type RoutingRule, type Skill, type Source } from "../lib/api"

const KINDS = ["keyword", "fallback", "semantic", "llm"] as const
const MODES = ["inherit", "static", "thrifty", "full"] as const

/** Rules for one skill, in evaluation order. First match wins, so any other order would
 *  misrepresent what actually happens at runtime. */
function rulesFor(skill: Skill, rules: RoutingRule[]): RoutingRule[] {
  return rules.filter((r) => r.skillId === skill.id).toSorted((a, b) => a.position - b.position)
}

/**
 * Skills and routing.
 *
 * This was a stack of tall cards, one per skill, each carrying two permanently-open forms — and
 * nothing that could be done to a skill once it existed. No rename, no edit, no way to switch one
 * off, no way to delete it, and no way to remove a routing rule typed wrongly. A business whose
 * Sales persona was wrong had to create a second skill and leave the first one answering
 * customers, because nothing could touch it.
 *
 * It is a table now, which is what a list of things you act on is, with the work behind dialogs so
 * the page is as long as its content rather than as long as its forms. The flow graph stays first:
 * the question an owner arrives with is "what happens to a message?".
 */
export function SkillsPage({ tenantSlug }: { tenantSlug: string }) {
  const t = useT()
  const [reloadKey, setReloadKey] = React.useState(0)
  const data = useFetch(() => api.getSkills(tenantSlug), [tenantSlug, reloadKey])
  const sources = useFetch(() => api.listSources(tenantSlug), [tenantSlug, reloadKey])

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<Skill | null>(null)
  const [ruleFor, setRuleFor] = React.useState<Skill | null>(null)
  const [linking, setLinking] = React.useState<Skill | null>(null)
  const [pendingSkill, setPendingSkill] = React.useState<Skill | null>(null)
  const [pendingRule, setPendingRule] = React.useState<RoutingRule | null>(null)

  const reload = () => setReloadKey((k) => k + 1)

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reload()
      return true
    } catch (cause) {
      // The server's message names the problem — an empty name, an invalid mode. Replacing it
      // with "something went wrong" throws away the only useful part.
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const linkedSkill =
    linking && data.status === "success"
      ? (data.data.skills.find((s) => s.id === linking.id) ?? linking)
      : linking

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t.skills.title}</h1>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add skill
        </Button>
      </div>

      {error && <MutationError message={error} />}

      {data.status === "pending" && <Skeleton className="h-32 w-full" />}
      {data.status === "error" && <MutationError message={data.message} />}

      {data.status === "success" && (
        <div className="space-y-6">
          {/* First, because the question an owner arrives with is "what happens to a message?",
              and the answer was previously only derivable by reading a position column across two
              separate lists. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.skills.graphTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              <RoutingGraph skills={data.data.skills} rules={data.data.rules} />
            </CardContent>
          </Card>

          {data.data.skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.skills.noSkills}</p>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.skills.columnSkill}</TableHead>
                      <TableHead>{t.skills.columnRoutingShort}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t.skills.columnDocuments}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.data.skills.map((skill) => {
                      const rules = rulesFor(skill, data.data.rules)
                      return (
                        <TableRow key={skill.id}>
                          <TableCell className="align-top">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">{skill.name}</span>
                              {skill.isFallback && <Badge variant="secondary">{t.skills.fallbackBadge}</Badge>}
                              {!skill.enabled && <Badge variant="outline">{t.skills.disabledBadge}</Badge>}
                              {skill.answerMode && (
                                <Badge variant="outline">{skill.answerMode}</Badge>
                              )}
                            </div>
                            {skill.systemPrompt && (
                              <p className="mt-1 line-clamp-2 max-w-sm text-xs text-muted-foreground">
                                {skill.systemPrompt}
                              </p>
                            )}
                          </TableCell>

                          <TableCell className="align-top">
                            {rules.length === 0 ? (
                              <span className="text-xs text-muted-foreground">
                                {t.skills.noRules}
                              </span>
                            ) : (
                              <ul className="space-y-1">
                                {rules.map((rule) => (
                                  <li key={rule.id} className="flex items-center gap-1.5 text-xs">
                                    <Badge variant="outline" className="h-4 px-1 tabular-nums">
                                      {rule.position}
                                    </Badge>
                                    <span className="text-muted-foreground">{rule.kind}</span>
                                    {rule.pattern && (
                                      <code className="rounded bg-muted px-1">{rule.pattern}</code>
                                    )}
                                    <button
                                      type="button"
                                      className="ml-auto text-muted-foreground hover:text-destructive"
                                      aria-label={`Remove rule ${rule.position} from ${skill.name}`}
                                      disabled={busy}
                                      onClick={() => setPendingRule(rule)}
                                    >
                                      ×
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </TableCell>

                          <TableCell className="hidden align-top text-xs text-muted-foreground sm:table-cell">
                            {skill.sources.length === 0
                              ? t.skills.allDocuments
                              : t.skills.linkedCount(skill.sources.length)}
                          </TableCell>

                          <TableCell className="align-top">
                            <RowActions
                              label={t.common.actionsFor(skill.name)}
                              actions={[
                                { label: t.common.edit, disabled: busy, onSelect: () => setEditing(skill) },
                                {
                                  label: t.skills.addRule,
                                  disabled: busy,
                                  onSelect: () => setRuleFor(skill),
                                },
                                {
                                  label: t.skills.chooseDocuments,
                                  disabled: busy,
                                  onSelect: () => setLinking(skill),
                                },
                                {
                                  label: skill.enabled ? "Disable" : "Enable",
                                  disabled: busy,
                                  onSelect: () =>
                                    void act(() =>
                                      api.updateSkill({
                                        tenantSlug,
                                        id: skill.id,
                                        enabled: !skill.enabled,
                                      }),
                                    ),
                                },
                                ...(skill.isFallback
                                  ? []
                                  : [
                                      {
                                        label: "Make the fallback",
                                        disabled: busy,
                                        onSelect: () =>
                                          void act(() =>
                                            api.updateSkill({
                                              tenantSlug,
                                              id: skill.id,
                                              isFallback: true,
                                            }),
                                          ),
                                      },
                                    ]),
                                {
                                  label: "Delete",
                                  destructive: true,
                                  disabled: busy,
                                  onSelect: () => setPendingSkill(skill),
                                },
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
          )}
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <SkillDialog
            title={t.skills.dialog.addTitle}
            description={t.skills.addDescription}
            busy={busy}
            onSubmit={async (values) => {
              const ok = await act(() =>
                api.createSkill({
                  tenantSlug,
                  name: values.name,
                  ...(values.systemPrompt ? { systemPrompt: values.systemPrompt } : {}),
                }),
              )
              if (ok) setAdding(false)
            }}
          />
        )}
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <SkillDialog
            title={t.skills.dialog.editTitle(editing.name)}
            description={t.skills.editDescription}
            busy={busy}
            initial={{
              name: editing.name,
              systemPrompt: editing.systemPrompt ?? "",
              answerMode: editing.answerMode ?? "inherit",
            }}
            onSubmit={async (values) => {
              const ok = await act(() =>
                api.updateSkill({
                  tenantSlug,
                  id: editing.id,
                  name: values.name,
                  systemPrompt: values.systemPrompt === "" ? null : values.systemPrompt,
                  answerMode: values.answerMode === "inherit" ? null : values.answerMode,
                }),
              )
              if (ok) setEditing(null)
            }}
          />
        )}
      </Dialog>

      <Dialog open={ruleFor !== null} onOpenChange={(open) => !open && setRuleFor(null)}>
        {ruleFor && (
          <RuleDialog
            skillName={ruleFor.name}
            busy={busy}
            onSubmit={async (kind, pattern) => {
              const ok = await act(() =>
                api.createRoutingRule({
                  tenantSlug,
                  skillId: ruleFor.id,
                  kind,
                  ...(pattern ? { pattern } : {}),
                }),
              )
              if (ok) setRuleFor(null)
            }}
          />
        )}
      </Dialog>

      <Dialog open={linking !== null} onOpenChange={(open) => !open && setLinking(null)}>
        {linkedSkill && sources.status === "success" && (
          <SourcesDialog
            skill={linkedSkill}
            sources={sources.data}
            busy={busy}
            onToggle={(sourceId, linked) =>
              act(() =>
                api.linkSkillSource({
                  tenantSlug,
                  skillId: linkedSkill.id,
                  sourceId,
                  linked,
                }),
              )
            }
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={pendingSkill !== null}
        title={t.skills.deleteTitle(pendingSkill?.name ?? "")}
        description={t.skills.deleteSkillDescription}
        confirmLabel={t.skills.deleteSkillConfirm}
        busy={busy}
        onCancel={() => setPendingSkill(null)}
        onConfirm={() => {
          const target = pendingSkill
          if (!target) return
          void act(async () => {
            await api.deleteSkill({ tenantSlug, id: target.id })
            setPendingSkill(null)
          })
        }}
      />

      <ConfirmDialog
        open={pendingRule !== null}
        title={t.skills.removeRuleTitle}
        description={t.skills.removeRuleDescription}
        confirmLabel={t.skills.removeRuleConfirm}
        busy={busy}
        onCancel={() => setPendingRule(null)}
        onConfirm={() => {
          const target = pendingRule
          if (!target) return
          void act(async () => {
            await api.deleteRoutingRule({ tenantSlug, id: target.id })
            setPendingRule(null)
          })
        }}
      />
    </div>
  )
}

/** One form for adding and for editing — the fields are identical, and two copies would drift. */
function SkillDialog({
  title,
  description,
  initial,
  busy,
  onSubmit,
}: {
  title: string
  description: string
  initial?: { name: string; systemPrompt: string; answerMode: string }
  busy: boolean
  onSubmit: (values: { name: string; systemPrompt: string; answerMode: string }) => void
}): React.ReactElement {
  const t = useT()
  const [name, setName] = React.useState(initial?.name ?? "")
  const [systemPrompt, setPrompt] = React.useState(initial?.systemPrompt ?? "")
  const [answerMode, setMode] = React.useState(initial?.answerMode ?? "inherit")

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="skill-name">{t.skills.dialog.nameLabel}</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.skills.namePlaceholder}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="skill-prompt">{t.skills.promptLabelLong}</Label>
          <Textarea
            id="skill-prompt"
            rows={3}
            value={systemPrompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t.skills.promptPlaceholder}
          />
          <p className="text-xs text-muted-foreground">{t.skills.promptFooter}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="skill-mode">{t.skills.dialog.modeLabel}</Label>
          <Select value={answerMode} onValueChange={setMode}>
            <SelectTrigger id="skill-mode" aria-label={t.skills.dialog.modeLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode === "inherit" ? t.skills.modeInheritShort : mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={busy || name.trim() === ""}
          onClick={() =>
            onSubmit({ name: name.trim(), systemPrompt: systemPrompt.trim(), answerMode })
          }
        >
          {t.common.save}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function RuleDialog({
  skillName,
  busy,
  onSubmit,
}: {
  skillName: string
  busy: boolean
  onSubmit: (kind: string, pattern: string) => void
}): React.ReactElement {
  const t = useT()
  const [kind, setKind] = React.useState<string>("keyword")
  const [pattern, setPattern] = React.useState("")
  const needsPattern = kind === "keyword"

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t.skills.ruleDialogTitle(skillName)}</DialogTitle>
        <DialogDescription>{t.skills.ruleOrderHint}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="rule-kind">{t.skills.ruleWhen}</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="rule-kind" aria-label={t.skills.ruleKindLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k === "keyword"
                    ? t.skills.ruleKeyword
                    : k === "fallback"
                      ? t.skills.ruleFallback
                      : k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(kind === "semantic" || kind === "llm") && (
            // Said here rather than discovered later: a rule of this kind sits in the list looking
            // configured and never fires, which is how "deferred" becomes "broken" in someone's
            // mind.
            <p className="text-xs text-muted-foreground">{t.skills.notBuiltHint}</p>
          )}
        </div>
        {needsPattern && (
          <div className="space-y-1">
            <Label htmlFor="rule-pattern">{t.skills.ruleWord}</Label>
            <Input
              id="rule-pattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder={t.skills.ruleWordPlaceholder}
            />
          </div>
        )}
      </div>
      <DialogFooter>
        <Button
          disabled={busy || (needsPattern && pattern.trim() === "")}
          onClick={() => onSubmit(kind, pattern.trim())}
        >
          {t.skills.ruleDialog.submit}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

/** Which documents a skill may answer from. None ticked means all of them, which is the useful
 *  default and worth saying rather than showing as an empty list. */
function SourcesDialog({
  skill,
  sources,
  busy,
  onToggle,
}: {
  skill: Skill
  sources: Source[]
  busy: boolean
  onToggle: (sourceId: string, linked: boolean) => void
}): React.ReactElement {
  const t = useT()
  const linked = new Set(skill.sources.map((s) => s.sourceId))
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t.skills.sourcesDialogTitle(skill.name)}</DialogTitle>
        <DialogDescription>{t.skills.noneTickedHint}</DialogDescription>
      </DialogHeader>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {sources.length === 0 && (
          <p className="text-sm text-muted-foreground">{t.skills.noDocuments}</p>
        )}
        {sources.map((source) => (
          <label key={source.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={linked.has(source.id)}
              disabled={busy}
              onChange={(e) => onToggle(source.id, e.target.checked)}
            />
            <span className="truncate">{source.title ?? source.uri}</span>
          </label>
        ))}
      </div>
    </DialogContent>
  )
}
