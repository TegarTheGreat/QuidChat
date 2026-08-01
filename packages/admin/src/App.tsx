import * as React from "react"
import { AppSidebar, type Section } from "./components/app-sidebar"
import { MutationError } from "./components/mutation-error"
import { SettingsDialog } from "./components/settings-dialog"
import { TokenGate } from "./components/token-gate"
import { Separator } from "./components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar"
import { useFetch } from "./hooks/use-fetch"
import { useTenant } from "./hooks/use-tenant"
import { useT } from "./i18n"
import { api } from "./lib/api"
import { clearToken } from "./lib/token"
import { setTenant } from "./lib/tenant"
import { ConversationsPage } from "./pages/conversations"
import { EscalationsPage } from "./pages/escalations"
import { KnowledgePage } from "./pages/knowledge"
import { OverviewPage } from "./pages/overview"
import { SetupPage } from "./pages/setup"
import { CannedAnswersPage } from "./pages/canned-answers"
import { ChannelsPage } from "./pages/channels"
import { SkillsPage } from "./pages/skills"
import { TenantsPage } from "./pages/tenants"

function AdminApp() {
  const t = useT()
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
          <h2 className="text-sm font-medium text-muted-foreground">{t.nav[section]}</h2>
        </header>
        <div className="flex-1 overflow-auto p-6">
          {tenants.status === "error" && <MutationError message={tenants.message} />}
          {!selectedTenant && tenants.status === "success" && (
            <p className="text-sm text-muted-foreground">{t.app.noTenants}</p>
          )}
          {selectedTenant && section === "setup" && (
            <SetupPage
              tenantSlug={selectedTenant}
              {...(tenantList.find((tenant) => tenant.slug === selectedTenant)?.id
                ? { tenantId: tenantList.find((tenant) => tenant.slug === selectedTenant)!.id }
                : {})}
              onGoTo={setSection}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}
          {selectedTenant && section === "overview" && (
            <OverviewPage
              tenantSlug={selectedTenant}
              onOpenEscalations={() => setSection("escalations")}
            />
          )}
          {selectedTenant && section === "knowledge" && <KnowledgePage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "conversations" && (
            <ConversationsPage tenantSlug={selectedTenant} />
          )}
          {selectedTenant && section === "skills" && <SkillsPage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "canned" && <CannedAnswersPage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "channels" && <ChannelsPage tenantSlug={selectedTenant} />}
          {selectedTenant && section === "escalations" && (
            <EscalationsPage tenantSlug={selectedTenant} />
          )}
          {section === "tenants" && (
            <TenantsPage
              tenants={tenantList}
              selectedTenant={selectedTenant}
              onSelectTenant={setTenant}
              onTenantsChanged={() => setTenantsReloadKey((k) => k + 1)}
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
