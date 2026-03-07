import { requiredPagePermissionsMap } from "@shared/access-control";
import { usePermissionMap } from "@/lib/auth.query";
import config from "@/lib/config";
import { useSecretsType } from "@/lib/secrets.query";

export function useSettingsTabs() {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const { data: secretsType } = useSecretsType();

  return [
    { label: "Your Account", href: "/settings/account" },
    { label: "Authentication", href: "/settings/auth" },
    ...(permissionMap?.["/settings/dual-llm"]
      ? [{ label: "Dual LLM", href: "/settings/dual-llm" }]
      : []),
    ...(permissionMap?.["/settings/security"]
      ? [{ label: "Security", href: "/settings/security" }]
      : []),
    ...(permissionMap?.["/settings/llm"]
      ? [{ label: "LLM", href: "/settings/llm" }]
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
    ...(permissionMap?.["/settings/appearance"]
      ? [{ label: "Appearance", href: "/settings/appearance" }]
      : []),
  ];
}
