"use client";

import { DEFAULT_ADMIN_EMAIL, DocsPage } from "@archestra/shared";
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
  useSession,
} from "@/lib/auth/auth.query";
import { useDisableBasicAuth } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useK8sCapabilities } from "@/lib/environment.query";
import { cn } from "@/lib/utils";

interface Warning {
  label: string;
  href: string;
  external: boolean;
}

export function SidebarWarningsAccordion() {
  const { data: session } = useSession();
  const userEmail = session?.user?.email;
  const { data: defaultCredentialsEnabled, isLoading: isLoadingCreds } =
    useDefaultCredentialsEnabled();
  const disableBasicAuth = useDisableBasicAuth();
  const { data: canUpdateOrg } = useHasPermissions({
    organization: ["update"],
  });
  // Reading capabilities needs environment:update, so gating the query on the
  // same permission keeps it from 403-ing for everyone else on every page.
  const { data: canUpdateEnvironment } = useHasPermissions({
    environment: ["update"],
  });
  const { data: capabilities } = useK8sCapabilities(
    canUpdateEnvironment === true,
  );
  const { state: sidebarState } = useSidebar();

  const showDefaultCredsWarning =
    canUpdateOrg === true &&
    disableBasicAuth === false &&
    !isLoadingCreds &&
    defaultCredentialsEnabled !== undefined &&
    defaultCredentialsEnabled &&
    userEmail === DEFAULT_ADMIN_EMAIL;

  // Only a measured verdict warns. "unknown" means nothing tested the cluster,
  // which is not evidence that egress rules are inert.
  //
  // networkPolicy is optional-chained despite being required in the response
  // type: a payload that does not match — an error envelope, an older backend —
  // would otherwise throw here and blank every page, since this renders in the
  // layout rather than on one screen.
  const showNetworkPolicyWarning =
    capabilities?.networkPolicy?.enforcementStatus === "verified-not-enforced";

  // Null under full white-labeling, where the environments screen carries the
  // same explanation and stays reachable.
  const networkPolicyDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformEnvironments,
    "network-egress-policies",
  );

  const warnings = [
    showDefaultCredsWarning && {
      label: "Change default credentials",
      href: "/account?highlight=change-password",
      external: false,
    },
    showNetworkPolicyWarning && {
      label: "Network policy not enforced",
      href: networkPolicyDocsUrl ?? "/settings/environments",
      external: networkPolicyDocsUrl !== null,
    },
  ].filter((w): w is Warning => Boolean(w));

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
                      <Link
                        href={w.href}
                        {...externalLinkProps(w.label, w.external)}
                      >
                        <span>{w.label}</span>
                      </Link>
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

function WarningItem({ label, href, external }: Warning) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={label}
        className="text-destructive hover:text-destructive"
      >
        <Link href={href} {...externalLinkProps(label, external)}>
          <AlertTriangle className="shrink-0" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// The new-tab hint rides on aria-label rather than an sr-only sibling, because
// SidebarMenuButton truncates its last span child and a second span would take
// that rule off the label, wrapping it to two lines.
function externalLinkProps(label: string, external: boolean) {
  return external
    ? ({
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": `${label} (opens in new tab)`,
      } as const)
    : {};
}
