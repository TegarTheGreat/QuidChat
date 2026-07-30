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

const NAV_ITEMS: { id: Section; title: string; icon: typeof LayoutDashboard }[] = [
  // Setup comes first: it is the screen that explains why a new installation is not
  // answering, and a first-time owner should meet it before anything else.
  { id: "setup", title: "Setup", icon: Wand2 },
  { id: "overview", title: "Overview", icon: LayoutDashboard },
  { id: "knowledge", title: "Knowledge", icon: BookOpen },
  { id: "conversations", title: "Conversations", icon: MessagesSquare },
  { id: "skills", title: "Skills & routing", icon: GitBranch },
  { id: "canned", title: "Canned answers", icon: MessageSquareQuote },
  { id: "channels", title: "Channels", icon: Radio },
  { id: "escalations", title: "Escalations", icon: AlertTriangle },
  { id: "tenants", title: "Tenants", icon: Building2 },
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
          <SidebarGroupLabel>QuidChat Admin</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={activeSection === item.id}
                    tooltip={item.title}
                    onClick={() => onSelectSection(item.id)}
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
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings" onClick={onOpenSettings}>
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Sign out" onClick={onSignOut}>
              <LogOut />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
