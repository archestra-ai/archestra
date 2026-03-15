"use client";

import { DEFAULT_ADMIN_EMAIL } from "@shared";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  useDefaultCredentialsEnabled,
  useHasPermissions,
} from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeature } from "@/lib/config.query";

export function SidebarWarningsAccordion() {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading: isLoadingCreds } =
    useDefaultCredentialsEnabled();
  const globalToolPolicy = useFeature("globalToolPolicy");
  const { data: canUpdateOrg } = useHasPermissions({
    agentSettings: ["update"],
  });

  const isPermissive = globalToolPolicy === "permissive";

  const showSecurityEngineWarning = !!session && canUpdateOrg && isPermissive;
  const showDefaultCredsWarning =
    canUpdateOrg &&
    !isLoadingCreds &&
    defaultCredentialsEnabled !== undefined &&
    defaultCredentialsEnabled &&
    userEmail === DEFAULT_ADMIN_EMAIL;

  if (!showSecurityEngineWarning && !showDefaultCredsWarning) {
    return null;
  }

  return (
    <SidebarGroup className="py-0 group-data-[collapsible=icon]:p-0">
      <SidebarGroupContent>
        <SidebarMenu>
          {showDefaultCredsWarning && (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip="Change default credentials"
                className="text-destructive hover:text-destructive"
              >
                <Link href="/settings/account?highlight=change-password">
                  <AlertTriangle className="shrink-0" />
                  <span>Change default credentials</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {showSecurityEngineWarning && (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip="Enable security engine"
                className="text-destructive hover:text-destructive"
              >
                <Link href="/mcp/tool-policies">
                  <AlertTriangle className="shrink-0" />
                  <span>Enable security engine</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
