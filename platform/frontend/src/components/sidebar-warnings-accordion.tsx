"use client";

import { DEFAULT_ADMIN_EMAIL } from "@shared";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  useDefaultCredentialsEnabled,
  useHasPermissions,
} from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeatures } from "@/lib/config.query";

export function SidebarWarningsAccordion() {
  const { data: session } = authClient.useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading: isLoadingCreds } =
    useDefaultCredentialsEnabled();
  const { data: features, isLoading: isLoadingFeatures } = useFeatures();
  const { data: canUpdateOrg } = useHasPermissions({
    securitySettings: ["update"],
  });

  const isPermissive = features?.globalToolPolicy === "permissive";

  const showSecurityEngineWarning =
    !!session &&
    canUpdateOrg &&
    !isLoadingFeatures &&
    features !== undefined &&
    isPermissive;
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
    <SidebarMenu>
      {showDefaultCredsWarning && (
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            className="text-destructive hover:text-destructive"
          >
            <Link href="/settings/auth">
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
  );
}
