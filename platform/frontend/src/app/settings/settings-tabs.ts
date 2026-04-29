import { requiredPagePermissionsMap } from "@shared/access-control";
import { usePermissionMap } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";

import { useSecretsType } from "@/lib/secrets.query";

export function useSettingsTabs() {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const { data: secretsType } = useSecretsType();
  return [
    { label: "Your Account", href: "/settings/account" },
    ...(permissionMap?.["/settings/api-keys"]
      ? [{ label: "API Keys", href: "/settings/api-keys" }]
      : []),
    ...(permissionMap?.["/settings/agents"]
      ? [{ label: "Agents", href: "/settings/agents" }]
      : []),
    ...(permissionMap?.["/settings/mcp"]
      ? [{ label: "MCP", href: "/settings/mcp" }]
      : []),
    ...(permissionMap?.["/settings/llm"]
      ? [{ label: "LLM", href: "/settings/llm" }]
      : []),
    ...(permissionMap?.["/settings/connection"]
      ? [{ label: "Connect page", href: "/settings/connection" }]
      : []),
    ...(permissionMap?.["/settings/knowledge"]
      ? [{ label: "Knowledge", href: "/settings/knowledge" }]
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
    ...(config.enterpriseFeatures.core &&
    permissionMap?.["/settings/identity-providers"]
      ? [{ label: "Identity Providers", href: "/settings/identity-providers" }]
      : []),
    ...(secretsType?.type === "Vault" && permissionMap?.["/settings/secrets"]
      ? [{ label: "Secrets", href: "/settings/secrets" }]
      : []),
    ...(permissionMap?.["/settings/organization"]
      ? [{ label: "Organization", href: "/settings/organization" }]
      : []),
  ];
}
