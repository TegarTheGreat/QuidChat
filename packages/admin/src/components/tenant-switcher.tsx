"use client"

import { Building2, ChevronsUpDown, Plus } from "lucide-react"
import { useT } from "../i18n"
import type { Tenant } from "../lib/api"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "./ui/sidebar"

/** Tenant picker shown in the sidebar header. The selected tenant persists in
 *  `localStorage` (see `lib/tenant.ts`), so this reflects — but does not own —
 *  that state. */
export function TenantSwitcher({
  tenants,
  selected,
  onSelect,
  onManageTenants,
}: {
  tenants: Tenant[]
  selected: string | null
  onSelect: (slug: string) => void
  onManageTenants: () => void
}) {
  const t = useT()
  const { isMobile } = useSidebar()
  // Named `tenant` rather than `t`, which now belongs to the dictionary.
  const activeTenant = tenants.find((tenant) => tenant.slug === selected) ?? null

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Building2 className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">
                  {activeTenant?.name ?? t.token.selectTenant}
                </span>
                <span className="truncate text-xs">
                  {activeTenant?.slug ?? t.token.noTenantSelected}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t.nav.tenants}
            </DropdownMenuLabel>
            {tenants.map((tenant) => (
              <DropdownMenuItem
                key={tenant.slug}
                onClick={() => onSelect(tenant.slug)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-sm border">
                  <Building2 className="size-4 shrink-0" />
                </div>
                <div className="grid flex-1 leading-tight">
                  <span className="truncate">{tenant.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{tenant.slug}</span>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2" onClick={onManageTenants}>
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Plus className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">{t.token.manageTenants}</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
