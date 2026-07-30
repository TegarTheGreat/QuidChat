import * as React from "react"
import { Blocks, Gauge, MessageSquareWarning, Palette } from "lucide-react"

import { MutationError } from "./mutation-error"
import { OriginsField } from "./origins-field"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "./ui/breadcrumb"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "./ui/sidebar"
import { Skeleton } from "./ui/skeleton"
import { TagInput } from "./ui/tag-input"
import { Textarea } from "./ui/textarea"
import { useFetch } from "../hooks/use-fetch"
import { useMutation } from "../hooks/use-mutation"
import { api, type Settings } from "../lib/api"

type Group = "models" | "answering" | "limits" | "widget"

const GROUPS: { id: Group; title: string; icon: typeof Blocks }[] = [
  { id: "models", title: "Models", icon: Blocks },
  { id: "answering", title: "Answering", icon: MessageSquareWarning },
  { id: "limits", title: "Limits", icon: Gauge },
  { id: "widget", title: "Widget", icon: Palette },
]

/** Every piece of configuration lives here, grouped and presented as a
 *  dialog, per the `sidebar-13` reference — nested sidebar navigation inside
 *  a `Dialog` rather than a full settings page. */
export function SettingsDialog({
  open,
  onOpenChange,
  tenantSlug,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenantSlug: string | null
}) {
  const [group, setGroup] = React.useState<Group>("models")
  const [draft, setDraft] = React.useState<Settings | null>(null)
  const [themeText, setThemeText] = React.useState("{}")
  const [themeError, setThemeError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  const fetched = useFetch(
    () => (tenantSlug && open ? api.getSettings(tenantSlug) : Promise.reject(new Error("no tenant"))),
    [tenantSlug, open],
  )

  React.useEffect(() => {
    if (fetched.status === "success") {
      setDraft(fetched.data)
      setThemeText(JSON.stringify(fetched.data.widget_theme, null, 2))
      setThemeError(null)
      setSaved(false)
    }
  }, [fetched])

  const { state: saveState, mutate: save } = useMutation(api.updateSettings)

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSaved(false)
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  async function handleSave() {
    if (!draft || !tenantSlug) return
    let widget_theme: Record<string, unknown>
    try {
      widget_theme = JSON.parse(themeText) as Record<string, unknown>
      setThemeError(null)
    } catch {
      setThemeError("Widget theme must be valid JSON.")
      return
    }
    try {
      await save({ ...draft, tenantSlug, widget_theme })
      setSaved(true)
    } catch {
      // Error text is shown from `saveState`; nothing further to do here.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[600px] md:max-w-[750px] lg:max-w-[850px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure the current tenant.
        </DialogDescription>
        <SidebarProvider className="items-start">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {GROUPS.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={group === item.id}
                          onClick={() => setGroup(item.id)}
                        >
                          <item.icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-[560px] flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>Settings</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {!tenantSlug && (
                <p className="text-sm text-muted-foreground">
                  Select a tenant first to edit its settings.
                </p>
              )}
              {tenantSlug && fetched.status === "pending" && (
                <div className="space-y-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-2/3" />
                </div>
              )}
              {tenantSlug && fetched.status === "error" && (
                <MutationError message={fetched.message} />
              )}
              {draft && (
                <>
                  {group === "models" && (
                    <div className="space-y-4">
                      <Field label="Chat model">
                        <Input
                          value={draft.chat_model}
                          onChange={(e) => update("chat_model", e.target.value)}
                        />
                      </Field>
                      <Field label="Rewrite model">
                        <Input
                          value={draft.rewrite_model}
                          onChange={(e) => update("rewrite_model", e.target.value)}
                        />
                      </Field>
                      <Field label="Embedding model">
                        <Input
                          value={draft.embedding_model}
                          onChange={(e) => update("embedding_model", e.target.value)}
                        />
                      </Field>
                    </div>
                  )}
                  {group === "answering" && (
                    <div className="space-y-4">
                      <Field label="Refusal text">
                        <Textarea
                          value={draft.refusal_text}
                          onChange={(e) => update("refusal_text", e.target.value)}
                          rows={3}
                        />
                      </Field>
                      <Field label="Escalation mode">
                        <Input
                          value={draft.escalation_mode}
                          onChange={(e) => update("escalation_mode", e.target.value)}
                        />
                      </Field>
                      <Field label="Escalation target">
                        <Input
                          value={draft.escalation_target}
                          onChange={(e) => update("escalation_target", e.target.value)}
                        />
                      </Field>
                      <Field label="High-risk topics">
                        <TagInput
                          value={draft.high_risk_topics}
                          onChange={(next) => update("high_risk_topics", next)}
                          placeholder="e.g. medical advice"
                          aria-label="High-risk topics"
                        />
                      </Field>
                    </div>
                  )}
                  {group === "limits" && (
                    <div className="space-y-4">
                      <Field label="Monthly budget (cents)">
                        <Input
                          type="number"
                          value={draft.monthly_budget_cents}
                          onChange={(e) =>
                            update("monthly_budget_cents", Number(e.target.value))
                          }
                        />
                      </Field>
                      <Field label="Retention (days)">
                        <Input
                          type="number"
                          value={draft.retention_days}
                          onChange={(e) => update("retention_days", Number(e.target.value))}
                        />
                      </Field>
                      <Field label="Max handoffs per turn">
                        <Input
                          type="number"
                          value={draft.max_handoffs_per_turn}
                          onChange={(e) =>
                            update("max_handoffs_per_turn", Number(e.target.value))
                          }
                        />
                      </Field>
                      <Field label="Max handoffs per conversation">
                        <Input
                          type="number"
                          value={draft.max_handoffs_per_conversation}
                          onChange={(e) =>
                            update("max_handoffs_per_conversation", Number(e.target.value))
                          }
                        />
                      </Field>
                    </div>
                  )}
                  {group === "widget" && (
                    <div className="space-y-4">
                      <Field label="Allowed origins">
                        <OriginsField
                          value={draft.allowed_origins}
                          onChange={(next) => update("allowed_origins", next)}
                        />
                      </Field>
                      <Field label="Widget theme (JSON)">
                        <Textarea
                          value={themeText}
                          onChange={(e) => {
                            setThemeText(e.target.value)
                            setSaved(false)
                          }}
                          rows={8}
                          className="font-mono text-xs"
                        />
                        {themeError && (
                          <p className="text-sm text-destructive">{themeError}</p>
                        )}
                      </Field>
                    </div>
                  )}

                  {saveState.status === "error" && <MutationError message={saveState.message} />}

                  <div className="flex items-center gap-3 border-t pt-4">
                    <Button onClick={handleSave} disabled={saveState.status === "pending"}>
                      {saveState.status === "pending" ? "Saving…" : "Save changes"}
                    </Button>
                    {saved && saveState.status === "success" && (
                      <span className="text-sm text-muted-foreground">Saved.</span>
                    )}
                  </div>
                </>
              )}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
