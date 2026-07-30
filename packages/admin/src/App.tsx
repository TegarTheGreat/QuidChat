import * as React from "react"
import { AppSidebar, type Section } from "./components/app-sidebar"
import { MutationError } from "./components/mutation-error"
import { SettingsDialog } from "./components/settings-dialog"
import { TokenGate } from "./components/token-gate"
import { Separator } from "./components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar"
import { useFetch } from "./hooks/use-fetch"
import { useTenant } from "./hooks/use-tenant"
import { api } from "./lib/api"
import { clearToken } from "./lib/token"
import { setTenant } from "./lib/tenant"
import { ConversationsPage } from "./pages/conversations"
import { EscalationsPage } from "./pages/escalations"
import { KnowledgePage } from "./pages/knowledge"
import { OverviewPage } from "./pages/overview"
import { SetupPage } from "./pages/setup"
import { SkillsPage } from "./pages/skills"
import { TenantsPage } from "./pages/tenants"

const SECTION_TITLES: Record<Section, string> = {
  setup: "Setup",
  overview: "Overview",
  knowledge: "Knowledge",
  conversations: "Conversations",
  skills: "Skills & routing",
  escalations: "Escalations",
  tenants: "Tenants",
}

function AdminApp() {
  const [section, setSection] = React.useState<Section>("setup")
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [tenantsReloadKey, setTenantsReloadKey] = React.useState(0)
  const selectedTenant = useTenant()

  const tenants = useFetch(() => api.listTenants(), [tenantsReloadKey])

  React.useEffect(() => {
    if (!selectedTenant && tenants.status === "success" && tenants.data.length > 0) {
      const first = tenants.data[0]
      if (first) setTenant(first.slug)
    }
  }, [selectedTenant, tenants])

  const tenantList = tenants.status === "success" ? tenants.data : []

  return (
    <SidebarProvider>
      <AppSidebar
        activeSection={section}
        onSelectSection={setSection}
        tenants={tenantList}
        selectedTenant={selectedTenant}
        onSelectTenant={setTenant}
        onOpenSettings={() => setSettingsOpen(true)}
        onSignOut={clearToken}
      />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h2 className="text-sm font-medium text-muted-foreground">
            {SECTION_TITLES[section]}
          </h2>
        </header>
        <div className="flex-1 overflow-auto p-6">
          {tenants.status === "error" && <MutationError message={tenants.message} />}
          {!selectedTenant && tenants.status === "success" && (
            <p className="text-sm text-muted-foreground">
              No tenants yet. Create one from the Tenants section.
            </p>
          )}
          {selectedTenant && section === "setup" && <SetupPage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "overview" && <OverviewPage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "knowledge" && <KnowledgePage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "conversations" && (
            <ConversationsPage tenantSlug={selectedTenant} />
          )}
          {selectedTenant && section === "skills" && <SkillsPage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "escalations" && (
            <EscalationsPage tenantSlug={selectedTenant} />
          )}
          {section === "tenants" && (
            <TenantsPage
              tenants={tenantList}
              selectedTenant={selectedTenant}
              onSelectTenant={setTenant}
              onTenantCreated={() => setTenantsReloadKey((k) => k + 1)}
            />
          )}
        </div>
      </SidebarInset>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} tenantSlug={selectedTenant} />
    </SidebarProvider>
  )
}

export function App() {
  return (
    <TokenGate>
      <AdminApp />
    </TokenGate>
  )
}
