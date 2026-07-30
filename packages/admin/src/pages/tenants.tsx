import * as React from "react"
import { Check } from "lucide-react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { TagInput } from "../components/ui/tag-input"
import { useMutation } from "../hooks/use-mutation"
import { api, type Tenant } from "../lib/api"

/** Create and switch tenant. The selected tenant is owned by the caller
 *  (`App`), which persists it in `localStorage` so it survives a refresh. */
export function TenantsPage({
  tenants,
  selectedTenant,
  onSelectTenant,
  onTenantCreated,
}: {
  tenants: Tenant[]
  selectedTenant: string | null
  onSelectTenant: (slug: string) => void
  onTenantCreated: () => void
}) {
  const [slug, setSlug] = React.useState("")
  const [name, setName] = React.useState("")
  const [origins, setOrigins] = React.useState<string[]>([])
  const { state, mutate: createTenant } = useMutation(api.createTenant)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const created = await createTenant({ slug, name, origins })
    setSlug("")
    setName("")
    setOrigins([])
    onTenantCreated()
    onSelectTenant(created.slug)
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Tenants</h1>
      <Card>
        <CardHeader>
          <CardTitle>All tenants</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {tenants.length === 0 && (
            <p className="text-sm text-muted-foreground">No tenants yet. Create one below.</p>
          )}
          {tenants.map((tenant) => (
            <div
              key={tenant.slug}
              className="flex items-center justify-between rounded-md border p-3"
            >
              <div>
                <p className="font-medium">{tenant.name}</p>
                <p className="text-sm text-muted-foreground">{tenant.slug}</p>
              </div>
              <div className="flex items-center gap-2">
                {tenant.slug === selectedTenant ? (
                  <Badge className="gap-1">
                    <Check className="size-3" /> Selected
                  </Badge>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => onSelectTenant(tenant.slug)}>
                    Switch
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a tenant</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="tenant-slug">Slug</Label>
              <Input
                id="tenant-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="acme"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tenant-name">Name</Label>
              <Input
                id="tenant-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc."
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Allowed origins</Label>
              <TagInput
                value={origins}
                onChange={setOrigins}
                placeholder="https://acme.example"
                aria-label="Origins"
              />
            </div>
            {state.status === "error" && <MutationError message={state.message} />}
            <Button type="submit" disabled={state.status === "pending"}>
              {state.status === "pending" ? "Creating…" : "Create tenant"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
