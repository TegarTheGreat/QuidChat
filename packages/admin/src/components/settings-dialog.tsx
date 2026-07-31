import * as React from "react"
import { Blocks, Gauge, MessageSquareWarning, Palette } from "lucide-react"

import { MutationError } from "./mutation-error"
import { OriginsField } from "./origins-field"
import { settingsPayload } from "./settings-payload"
import { mergeWidgetTheme } from "./settings-theme"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"
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
  // The theme is edited as fields, not as JSON. A business owner should not have to know that
  // the column is jsonb, and a hand-typed object is a way to store a colour the widget will
  // silently reject — which reads as the setting not working.
  /**
   * The theme is a jsonb blob, and this form knows only part of it. `handleSave` used to rebuild
   * it from the fields on screen, so a shop that changed its accent colour silently lost its
   * language, greeting and opening questions — reverting its customers to English chrome with no
   * questions to tap, with nothing said about it. Everything stored is kept and edited fields are
   * merged over the top, which also means a key added later survives a save from an older panel.
   */
  const [storedTheme, setStoredTheme] = React.useState<Record<string, unknown>>({})
  const [theme, setTheme] = React.useState<{
    primaryColor: string
    position: string
    title: string
    locale: string
    greeting: string
    starters: string[]
  }>({
    primaryColor: "#1a56db",
    position: "right",
    title: "Chat assistant",
    locale: "en",
    greeting: "",
    starters: [],
  })
  const [saved, setSaved] = React.useState(false)

  const fetched = useFetch(
    () => (tenantSlug && open ? api.getSettings(tenantSlug) : Promise.reject(new Error("no tenant"))),
    [tenantSlug, open],
  )

  React.useEffect(() => {
    if (fetched.status === "success") {
      setDraft(fetched.data)
      const stored = (fetched.data.widget_theme ?? {}) as Record<string, unknown>
      setStoredTheme(stored)
      setTheme({
        // Falls back to the widget's own defaults, so an unset theme shows what a visitor
        // actually sees rather than an empty field.
        primaryColor: typeof stored.primaryColor === "string" ? stored.primaryColor : "#1a56db",
        position: stored.position === "left" ? "left" : "right",
        title: typeof stored.title === "string" && stored.title !== "" ? stored.title : "Chat assistant",
        locale: stored.locale === "id" ? "id" : "en",
        greeting: typeof stored.greeting === "string" ? stored.greeting : "",
        starters: Array.isArray(stored.starters)
          ? stored.starters.filter((q): q is string => typeof q === "string")
          : [],
      })
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
    const widget_theme = mergeWidgetTheme(storedTheme, theme)
    try {
      // Only the editable fields. Spreading `draft` sent `tenant_id` too, which the API refuses,
      // so every save from this dialog returned 400 and nothing in it could be changed.
      await save({ ...settingsPayload(draft, widget_theme), tenantSlug })
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
                      <Field label="Answer mode">
                        <Select
                          value={draft.answer_mode}
                          // The component hands back a plain string and the setting is a
                          // three-value union. Narrowing here keeps an impossible value from
                          // reaching the API rather than discovering it as a 400.
                          onValueChange={(next) => {
                            if (next === "static" || next === "thrifty" || next === "full") {
                              update("answer_mode", next)
                            }
                          }}
                        >
                          <SelectTrigger aria-label="Answer mode">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="full">
                              full — generate an answer from your documents
                            </SelectItem>
                            <SelectItem value="thrifty">
                              thrifty — quote your documents, no generation
                            </SelectItem>
                            <SelectItem value="static">
                              static — approved canned answers only, no model
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="mt-1 text-xs text-muted-foreground">
                          The one setting that changes what running this costs.{" "}
                          <strong>static</strong> never calls a model, so it is free to run and
                          can only say what someone approved.
                        </p>
                      </Field>
                      <Field label="Refusal text">
                        <Textarea
                          value={draft.refusal_text}
                          onChange={(e) => update("refusal_text", e.target.value)}
                          rows={3}
                        />
                      </Field>
                      <Field label="When it cannot answer">
                        <Select
                          value={draft.escalation_mode}
                          onValueChange={(next) => {
                            if (next === "collect_contact" || next === "webhook") {
                              update("escalation_mode", next)
                            }
                          }}
                        >
                          <SelectTrigger aria-label="Escalation mode">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="collect_contact">
                              record it here — read them under Escalations
                            </SelectItem>
                            <SelectItem value="webhook">
                              post it to a webhook — Slack, Discord, n8n, your CRM
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Webhook URL">
                        <Input
                          value={draft.escalation_target}
                          onChange={(e) => update("escalation_target", e.target.value)}
                          placeholder="https://hooks.slack.com/services/…"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                          Sent as JSON with the customer&rsquo;s question, the reason, and the
                          channel — the question is the part that tells you what to write. Only
                          used when the mode above is set to webhook.
                        </p>
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
                      <Field label="Accent colour">
                        <div className="flex items-center gap-2">
                          <Input
                            type="color"
                            aria-label="Accent colour"
                            className="h-9 w-16 p-1"
                            value={theme.primaryColor}
                            onChange={(e) => {
                              // A colour input can only produce #rrggbb, which is exactly the
                              // shape the widget accepts — so the control itself is the
                              // validation, and a value that would be rejected cannot be typed.
                              setTheme((t) => ({ ...t, primaryColor: e.target.value }))
                              setSaved(false)
                            }}
                          />
                          <span className="font-mono text-sm text-muted-foreground">
                            {theme.primaryColor}
                          </span>
                        </div>
                      </Field>
                      <Field label="Which side it sits on">
                        <Select
                          value={theme.position}
                          onValueChange={(next) => {
                            setTheme((t) => ({ ...t, position: next }))
                            setSaved(false)
                          }}
                        >
                          <SelectTrigger aria-label="Widget position">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="right">bottom right</SelectItem>
                            <SelectItem value="left">bottom left</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Language of the buttons and placeholder">
                        <Select
                          value={theme.locale}
                          onValueChange={(next) => {
                            setTheme((t) => ({ ...t, locale: next }))
                            setSaved(false)
                          }}
                        >
                          <SelectTrigger aria-label="Widget language">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="id">Bahasa Indonesia</SelectItem>
                            <SelectItem value="en">English</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Only the parts you do not write — the send button, the placeholder, the
                          progress lines. Your greeting and answers stay in whatever language you
                          write them.
                        </p>
                      </Field>
                      <Field label="First thing a customer reads">
                        <Textarea
                          value={theme.greeting}
                          rows={2}
                          onChange={(e) => {
                            setTheme((t) => ({ ...t, greeting: e.target.value }))
                            setSaved(false)
                          }}
                          placeholder="Halo! Ada yang bisa kami bantu?"
                          aria-label="Widget greeting"
                        />
                      </Field>
                      <Field label="Questions offered before they type">
                        <TagInput
                          value={theme.starters}
                          onChange={(next) => {
                            setTheme((t) => ({ ...t, starters: next }))
                            setSaved(false)
                          }}
                          placeholder="e.g. Berapa lama garansinya?"
                          aria-label="Opening questions"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                          Leave empty and your approved canned answers are offered instead —
                          questions you already know you get, and that are guaranteed answerable.
                        </p>
                      </Field>
                      <Field label="Title your customers see">
                        <Input
                          value={theme.title}
                          onChange={(e) => {
                            setTheme((t) => ({ ...t, title: e.target.value }))
                            setSaved(false)
                          }}
                          placeholder="Chat assistant"
                        />
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
