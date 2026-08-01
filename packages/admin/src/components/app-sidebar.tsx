"use client"

import {
  AlertTriangle,
  BookOpen,
  Building2,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Settings,
  Wand2,
  GitBranch,
  MessageSquareQuote,
  Radio,
} from "lucide-react"
import type { Tenant } from "../lib/api"
import { useLocale, useT, type Dict } from "../i18n"
import { LanguagePicker } from "./language-picker"

import { TenantSwitcher } from "./tenant-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar"

export type Section = "setup" | "overview" | "knowledge" | "skills" | "canned" | "channels" | "conversations" | "escalations" | "tenants"

/** The order is the product's own opinion; the words come from whichever language is on. Setup
 *  is first because it explains why a new installation is not answering yet, and a first-time
 *  owner should meet that before anything else. */
const NAV_ITEMS: { id: Section; label: (t: Dict) => string; icon: typeof LayoutDashboard }[] = [
  { id: "setup", label: (t) => t.nav.setup, icon: Wand2 },
  { id: "overview", label: (t) => t.nav.overview, icon: LayoutDashboard },
  { id: "knowledge", label: (t) => t.nav.knowledge, icon: BookOpen },
  { id: "conversations", label: (t) => t.nav.conversations, icon: MessagesSquare },
  { id: "skills", label: (t) => t.nav.skills, icon: GitBranch },
  { id: "canned", label: (t) => t.nav.canned, icon: MessageSquareQuote },
  { id: "channels", label: (t) => t.nav.channels, icon: Radio },
  { id: "escalations", label: (t) => t.nav.escalations, icon: AlertTriangle },
  { id: "tenants", label: (t) => t.nav.tenants, icon: Building2 },
]

/** The app-wide collapsible icon-rail sidebar. Every section of the admin
 *  panel is reachable from here; Settings lives behind a dialog trigger
 *  instead of a route, per the `sidebar-13` reference. */
export function AppSidebar({
  activeSection,
  onSelectSection,
  tenants,
  selectedTenant,
  onSelectTenant,
  onOpenSettings,
  onSignOut,
}: {
  activeSection: Section
  onSelectSection: (section: Section) => void
  tenants: Tenant[]
  selectedTenant: string | null
  onSelectTenant: (slug: string) => void
  onOpenSettings: () => void
  onSignOut: () => void
}) {
  const t = useT()
  const { locale, setLocale } = useLocale()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <TenantSwitcher
          tenants={tenants}
          selected={selectedTenant}
          onSelect={onSelectTenant}
          onManageTenants={() => onSelectSection("tenants")}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t.nav.brand}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={activeSection === item.id}
                    tooltip={item.label(t)}
                    onClick={() => onSelectSection(item.id)}
                  >
                    <item.icon />
                    <span>{item.label(t)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {/* In the footer with the other settings, and above them: someone who cannot read the
              panel needs this before they need anything else on it. */}
          <SidebarMenuItem>
            <LanguagePicker locale={locale} onChange={setLocale} />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={t.nav.settings} onClick={onOpenSettings}>
              <Settings />
              <span>{t.nav.settings}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={t.nav.signOut} onClick={onSignOut}>
              <LogOut />
              <span>{t.nav.signOut}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
