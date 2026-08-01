import * as React from "react"
import { Check } from "lucide-react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent } from "../components/ui/card"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table"
import { TagInput } from "../components/ui/tag-input"
import { useT } from "../i18n"
import { api, type Tenant } from "../lib/api"

/**
 * The businesses this server answers for.
 *
 * A tenant could be created and then never touched again: no rename, no removal, and the page was
 * a stack of bordered divs with a permanently-open form below them. A typo in the name — the thing
 * an owner reads in the picker every day — was permanent, and a test tenant made while trying the
 * product out stayed in the list forever.
 *
 * The slug is deliberately not editable. It is inside every embed script already pasted onto a
 * website; changing it would break each of them silently, and the shop would learn about it from a
 * customer rather than from us. Changing a slug means making a new tenant.
 */
export function TenantsPage({
  tenants,
  selectedTenant,
  onSelectTenant,
  onTenantsChanged,
}: {
  tenants: Tenant[]
  selectedTenant: string | null
  onSelectTenant: (slug: string) => void
  onTenantsChanged: () => void
}) {
  const t = useT()
  const [creating, setCreating] = React.useState(false)
  const [renaming, setRenaming] = React.useState<Tenant | null>(null)
  const [deleting, setDeleting] = React.useState<Tenant | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onTenantsChanged()
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
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t.tenants.title}</h1>
        <Button size="sm" onClick={() => setCreating(true)}>
          {t.tenants.addTenant}
        </Button>
      </div>

      {error && <MutationError message={error} />}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.tenants.columnName}</TableHead>
                <TableHead>{t.tenants.columnSlug}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    {t.tenants.empty}
                  </TableCell>
                </TableRow>
              )}
              {tenants.map((tenant) => (
                <TableRow key={tenant.slug}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      {tenant.name}
                      {tenant.slug === selectedTenant && (
                        <Badge variant="secondary" className="gap-1">
                          <Check className="size-3" /> {t.tenants.openBadge}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {tenant.slug}
                  </TableCell>
                  <TableCell>
                    <RowActions
                      label={t.common.actionsFor(tenant.name)}
                      actions={[
                        ...(tenant.slug === selectedTenant
                          ? []
                          : [
                              {
                                label: t.tenants.workOnThis,
                                disabled: busy,
                                onSelect: () => onSelectTenant(tenant.slug),
                              },
                            ]),
                        { label: t.tenants.rename, disabled: busy, onSelect: () => setRenaming(tenant) },
                        {
                          label: t.tenants.delete,
                          destructive: true,
                          disabled: busy,
                          onSelect: () => setDeleting(tenant),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && (
          <CreateTenantDialog
            busy={busy}
            onCreate={async (body) => {
              const ok = await act(async () => {
                const created = await api.createTenant(body)
                onSelectTenant(created.slug)
              })
              if (ok) setCreating(false)
            }}
          />
        )}
      </Dialog>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        {renaming && (
          <RenameTenantDialog
            tenant={renaming}
            busy={busy}
            onRename={async (name) => {
              const ok = await act(() => api.renameTenant({ slug: renaming.slug, name }))
              if (ok) setRenaming(null)
            }}
          />
        )}
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        {deleting && (
          <DeleteTenantDialog
            tenant={deleting}
            busy={busy}
            onDelete={async () => {
              const target = deleting
              const ok = await act(() =>
                api.deleteTenant({ slug: target.slug, confirm: target.slug }),
              )
              if (!ok) return
              setDeleting(null)
              // Nothing else in the panel works against a tenant that no longer exists, so move to
              // whatever is left rather than leaving every other screen erroring on a dead slug.
              if (target.slug === selectedTenant) {
                const next = tenants.find((candidate) => candidate.slug !== target.slug)
                if (next) onSelectTenant(next.slug)
              }
            }}
          />
        )}
      </Dialog>
    </div>
  )
}

function CreateTenantDialog({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (body: { slug: string; name: string; origins: string[] }) => void
}): React.ReactElement {
  const t = useT()
  const [slug, setSlug] = React.useState("")
  const [name, setName] = React.useState("")
  const [origins, setOrigins] = React.useState<string[]>([])

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t.tenants.createTitle}</DialogTitle>
        <DialogDescription>{t.tenants.createDescription}</DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          onCreate({ slug: slug.trim(), name: name.trim(), origins })
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="tenant-name">{t.tenants.nameLabel}</Label>
          <Input
            id="tenant-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Toko Berkah"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tenant-slug">{t.tenants.slugLabel}</Label>
          <Input
            id="tenant-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="toko-berkah"
            required
          />
          <p className="text-xs text-muted-foreground">{t.tenants.slugHint}</p>
        </div>
        <div className="space-y-1">
          <Label>{t.tenants.originsLabel}</Label>
          <TagInput
            value={origins}
            onChange={setOrigins}
            placeholder="https://tokoberkah.example"
            aria-label="Origins"
          />
          <p className="text-xs text-muted-foreground">{t.tenants.originsHint}</p>
        </div>
        <DialogFooter>
          <Button type="submit" disabled={busy || slug.trim() === "" || name.trim() === ""}>
            {busy ? t.tenants.creating : t.tenants.createSubmit}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function RenameTenantDialog({
  tenant,
  busy,
  onRename,
}: {
  tenant: Tenant
  busy: boolean
  onRename: (name: string) => void
}): React.ReactElement {
  const t = useT()
  const [name, setName] = React.useState(tenant.name)

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t.tenants.renameTitle(tenant.name)}</DialogTitle>
        <DialogDescription>{t.tenants.renameDescription(tenant.slug)}</DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          onRename(name.trim())
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="tenant-rename">{t.tenants.nameLabel}</Label>
          <Input
            id="tenant-rename"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <DialogFooter>
          <Button type="submit" disabled={busy || name.trim() === ""}>
            {busy ? t.common.saving : t.tenants.renameSubmit}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

/**
 * Deleting a tenant is the largest thing this product can do, so it asks for the slug to be typed
 * out rather than sitting one click away in the same menu as "Rename". Two shops with similar
 * names in one list is the ordinary case, not the unusual one.
 */
function DeleteTenantDialog({
  tenant,
  busy,
  onDelete,
}: {
  tenant: Tenant
  busy: boolean
  onDelete: () => void
}): React.ReactElement {
  const t = useT()
  const [typed, setTyped] = React.useState("")
  const matches = typed.trim() === tenant.slug

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t.tenants.deleteTitle(tenant.name)}</DialogTitle>
        <DialogDescription>{t.tenants.deleteDescription}</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label htmlFor="tenant-confirm">{t.tenants.deleteConfirmLabel(tenant.slug)}</Label>
        <Input
          id="tenant-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={busy || !matches} onClick={onDelete}>
          {busy ? t.tenants.deleting : t.tenants.deleteSubmit}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
