import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import {
  AppWindow,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Fingerprint,
  Github,
  KeyRound,
  Library,
  Lock,
  MessageSquare,
  MessagesSquare,
  Palette,
  Plug,
  PlugZap,
  ShieldCheck,
  ShieldUser,
  UserCog,
  Users,
  UsersRound,
} from "lucide-react";
import { usePermissionMap } from "@/lib/auth/auth.query";

import { useSecretsType } from "@/lib/secrets.query";

export function useSettingsTabs() {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const { data: secretsType } = useSecretsType();
  return [
    ...(permissionMap?.["/settings/appearance"]
      ? [{ label: "Appearance", href: "/settings/appearance", Icon: Palette }]
      : []),
    ...(permissionMap?.["/settings/auth"]
      ? [{ label: "Auth", href: "/settings/auth", Icon: Lock }]
      : []),
    ...(permissionMap?.["/settings/service-accounts"]
      ? [
          {
            label: "Service Accounts",
            href: "/settings/service-accounts",
            Icon: Bot,
          },
        ]
      : []),
    ...(permissionMap?.["/settings/oauth-clients"]
      ? [
          {
            label: "OAuth Clients",
            href: "/settings/oauth-clients",
            Icon: ShieldUser,
          },
        ]
      : []),
    ...(permissionMap?.["/settings/agents"]
      ? [{ label: "Agents", href: "/settings/agents", Icon: MessageSquare }]
      : []),
    ...(permissionMap?.["/settings/messaging-channels"]
      ? [
          {
            label: "Messaging Channels",
            href: "/settings/messaging-channels",
            Icon: MessagesSquare,
          },
        ]
      : []),
    ...(permissionMap?.["/settings/llm"]
      ? [{ label: "LLM", href: "/settings/llm", Icon: Brain }]
      : []),
    ...(permissionMap?.["/settings/mcp"]
      ? [{ label: "MCP", href: "/settings/mcp", Icon: Plug }]
      : []),
    ...(permissionMap?.["/settings/connection"]
      ? [{ label: "Connection", href: "/settings/connection", Icon: PlugZap }]
      : []),
    ...(permissionMap?.["/settings/apps"]
      ? [{ label: "Apps", href: "/settings/apps", Icon: AppWindow }]
      : []),
    ...(permissionMap?.["/settings/skills"]
      ? [{ label: "Skills", href: "/settings/skills", Icon: BookOpen }]
      : []),
    ...(permissionMap?.["/settings/security"]
      ? [{ label: "Security", href: "/settings/security", Icon: ShieldCheck }]
      : []),
    ...(permissionMap?.["/settings/knowledge"]
      ? [{ label: "Knowledge", href: "/settings/knowledge", Icon: Library }]
      : []),
    ...(permissionMap?.["/settings/environments"]
      ? [{ label: "Environments", href: "/settings/environments", Icon: Boxes }]
      : []),
    ...(permissionMap?.["/settings/users"]
      ? [{ label: "Users", href: "/settings/users", Icon: Users }]
      : []),
    ...(permissionMap?.["/settings/teams"]
      ? [{ label: "Teams", href: "/settings/teams", Icon: UsersRound }]
      : []),
    ...(permissionMap?.["/settings/roles"]
      ? [{ label: "Roles", href: "/settings/roles", Icon: UserCog }]
      : []),
    ...(permissionMap?.["/settings/github"]
      ? [{ label: "GitHub", href: "/settings/github", Icon: Github }]
      : []),
    // Always render the Identity Providers tab when the user has the
    // permission — the destination page handles dimming when the enterprise
    // license is inactive, no need to gate the nav entry as well.
    ...(permissionMap?.["/settings/identity-providers"]
      ? [
          {
            label: "Identity Providers",
            href: "/settings/identity-providers",
            Icon: Fingerprint,
          },
        ]
      : []),
    ...(secretsType?.type === "Vault" && permissionMap?.["/settings/secrets"]
      ? [{ label: "Secrets", href: "/settings/secrets", Icon: KeyRound }]
      : []),
  ];
}

/**
 * The settings entry a path belongs to. A detail route like
 * `/settings/service-accounts/<id>` has to keep its parent lit, so the longest
 * matching href wins rather than the first.
 */
export function resolveSettingsSection(
  pathname: string,
  tabs: { href: string }[],
): string {
  return (
    [...tabs]
      .sort((a, b) => b.href.length - a.href.length)
      .find(({ href }) => pathname === href || pathname.startsWith(`${href}/`))
      ?.href ?? ""
  );
}
