"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { SidebarPrefetchLink } from "@/app/_parts/sidebar-prefetch-link";
import type { SettingsNavGroup } from "@/app/settings/settings-tabs";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

// The settings variant's inner content (back-button header + grouped settings
// nav). It is rendered inside the single shared <Sidebar> in AppSidebar — so it
// returns a fragment, NOT its own <Sidebar>. Keeping one <Sidebar> means one
// mobile <Sheet>, which never remounts when switching between settings and
// chats/studio, so the drawer slide-in only plays on a genuine open.
export function SettingsSidebarContent({
  returnPath,
  groups,
  pathname,
  isAuthenticated,
}: {
  returnPath: string;
  groups: SettingsNavGroup[];
  pathname: string;
  isAuthenticated: boolean;
}) {
  const router = useRouter();

  return (
    <>
      <SidebarHeader className="pt-4 group-data-[collapsible=icon]:pt-2 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-1">
        <button
          type="button"
          onClick={() => router.push(returnPath)}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <ArrowLeft className="size-4 shrink-0" />
          <span className="text-sm font-semibold group-data-[collapsible=icon]:hidden">
            Settings
          </span>
        </button>
      </SidebarHeader>
      <SidebarContent>
        {isAuthenticated && <NavSettings groups={groups} pathname={pathname} />}
      </SidebarContent>
    </>
  );
}

// Grouped settings destinations (Personal / Organization), using the same
// SidebarGroup primitives as the rest of the sidebar.
function NavSettings({
  groups,
  pathname,
}: {
  groups: SettingsNavGroup[];
  pathname: string;
}) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    tooltip={item.label}
                    isActive={pathname.startsWith(item.href)}
                  >
                    <SidebarPrefetchLink
                      href={item.href}
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      <span>{item.label}</span>
                    </SidebarPrefetchLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}
