"use client";

import { DEFAULT_ADMIN_EMAIL } from "@shared";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  useDefaultCredentialsEnabled,
  useHasPermissions,
} from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDisableBasicAuth, useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils";

export function SidebarWarningsAccordion() {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading: isLoadingCreds } =
    useDefaultCredentialsEnabled();
  const globalToolPolicy = useFeature("globalToolPolicy");
  const disableBasicAuth = useDisableBasicAuth();
  const { data: canUpdateOrg } = useHasPermissions({
    organization: ["update"],
  });
  const { data: canUpdateAgentSettings } = useHasPermissions({
    agentSettings: ["update"],
  });
  const { state: sidebarState } = useSidebar();

  const isPermissive = globalToolPolicy === "permissive";

  const showSecurityEngineWarning =
    !!session && canUpdateAgentSettings === true && isPermissive;
  const showDefaultCredsWarning =
    canUpdateOrg === true &&
    disableBasicAuth === false &&
    !isLoadingCreds &&
    defaultCredentialsEnabled !== undefined &&
    defaultCredentialsEnabled &&
    userEmail === DEFAULT_ADMIN_EMAIL;

  const warnings = [
    showDefaultCredsWarning && {
      label: "Change default credentials",
      href: "/settings/account?highlight=change-password",
    },
    showSecurityEngineWarning && {
      label: "Enable security engine",
      href: "/mcp/tool-guardrails",
    },
  ].filter((w): w is { label: string; href: string } => Boolean(w));

  if (warnings.length === 0) {
    return null;
  }

  const isCollapsed = sidebarState === "collapsed";

  return (
    <SidebarGroup className="p-0 ">
      <SidebarGroupContent>
        <SidebarMenu>
          {isCollapsed ? (
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton className="text-destructive hover:text-destructive">
                    <AlertTriangle className="shrink-0" />
                    <span>Security warnings</span>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end">
                  {warnings.map((w) => (
                    <DropdownMenuItem
                      asChild
                      key={w.label}
                      className="cursor-pointer"
                    >
                      <Link href={w.href}>{w.label}</Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div
                data-sidebar="menu-badge"
                className={cn(
                  "pointer-events-none absolute right-1 top-1.5 flex h-5 min-w-5 select-none items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums",
                  "text-destructive",
                  "group-data-[collapsible=icon]:hidden",
                )}
              >
                {warnings.length}
              </div>

              <span
                className={cn(
                  "pointer-events-none absolute top-0.5 right-0.5 z-10",
                  "hidden group-data-[collapsible=icon]:flex",
                  "h-3.5 min-w-3.5 items-center justify-center rounded-full",
                  "bg-destructive text-[9px] font-bold leading-none",
                  "text-destructive-foreground",
                )}
              >
                {warnings.length}
              </span>
            </SidebarMenuItem>
          ) : (
            warnings.map((w) => <WarningItem key={w.label} {...w} />)
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function WarningItem({ label, href }: { label: string; href: string }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={label}
        className="text-destructive hover:text-destructive"
      >
        <Link href={href}>
          <AlertTriangle className="shrink-0" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
