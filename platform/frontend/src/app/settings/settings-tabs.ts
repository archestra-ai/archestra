import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { usePathname } from "next/navigation";
import React from "react";
import { usePermissionMap } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";

import { useSecretsType } from "@/lib/secrets.query";

interface SettingsNavItem {
  label: string;
  href: string;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

/**
 * Settings navigation grouped by scope: a "Personal" group (your account + your
 * programmatic tokens) and an "Organization" group (org-wide admin config,
 * including the org-wide AI defaults). Items are permission-gated the same way
 * the page routes are (via `requiredPagePermissionsMap`); empty groups drop out.
 */
export function useSettingsNavGroups(): SettingsNavGroup[] {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const { data: secretsType } = useSecretsType();

  const personal: SettingsNavItem[] = [
    { label: "Your Account", href: "/settings/account" },
    ...(permissionMap?.["/settings/api-keys"]
      ? [{ label: "API Keys", href: "/settings/api-keys" }]
      : []),
  ];

  const organization: SettingsNavItem[] = [
    ...(permissionMap?.["/settings/organization"]
      ? [{ label: "Overview", href: "/settings/organization" }]
      : []),
    ...(permissionMap?.["/settings/users"]
      ? [{ label: "Users", href: "/settings/users" }]
      : []),
    ...(permissionMap?.["/settings/teams"]
      ? [{ label: "Teams", href: "/settings/teams" }]
      : []),
    ...(permissionMap?.["/settings/roles"]
      ? [{ label: "Roles", href: "/settings/roles" }]
      : []),
    ...(permissionMap?.["/settings/service-accounts"]
      ? [{ label: "Service Accounts", href: "/settings/service-accounts" }]
      : []),
    ...(permissionMap?.["/settings/environments"]
      ? [{ label: "Environments", href: "/settings/environments" }]
      : []),
    ...(secretsType?.type === "Vault" && permissionMap?.["/settings/secrets"]
      ? [{ label: "Secrets", href: "/settings/secrets" }]
      : []),
    ...(permissionMap?.["/settings/github"]
      ? [{ label: "GitHub", href: "/settings/github" }]
      : []),
    ...(config.enterpriseFeatures.core &&
    permissionMap?.["/settings/identity-providers"]
      ? [{ label: "Identity Providers", href: "/settings/identity-providers" }]
      : []),
    ...(permissionMap?.["/settings/llm"]
      ? [{ label: "LLM", href: "/settings/llm" }]
      : []),
    ...(permissionMap?.["/settings/agents"]
      ? [{ label: "Agents", href: "/settings/agents" }]
      : []),
    ...(permissionMap?.["/settings/knowledge"]
      ? [{ label: "Knowledge", href: "/settings/knowledge" }]
      : []),
  ];

  const groups: SettingsNavGroup[] = [];
  if (personal.length > 0) {
    groups.push({ label: "Personal", items: personal });
  }
  if (organization.length > 0) {
    groups.push({ label: "Organization", items: organization });
  }
  return groups;
}

// Where the settings "back" button returns to when there is no prior in-app
// page (deep link / new tab / reload) — the first chats nav item, New Chat.
const SETTINGS_FALLBACK_PATH = "/chat";

/**
 * Resolves where the settings "back" button should navigate. Tracks the last
 * non-settings route the user visited (so back returns to the page they came
 * from) and falls back to New Chat when there is none. Must be called from an
 * always-mounted component so the ref survives client-side navigations.
 */
export function useSettingsReturnPath(): string {
  const pathname = usePathname();
  const lastNonSettingsPath = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!pathname.startsWith("/settings")) {
      lastNonSettingsPath.current = pathname;
    }
  }, [pathname]);

  return lastNonSettingsPath.current ?? SETTINGS_FALLBACK_PATH;
}
