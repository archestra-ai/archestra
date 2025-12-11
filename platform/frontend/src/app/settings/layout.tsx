"use client";

import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth.query";
import config from "@/lib/config";
import { useSecretsType } from "@/lib/secrets.query";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: userCanReadOrganization } = useHasPermissions({
    organization: ["read"],
  });

  const { data: userCanReadSsoProviders } = useHasPermissions({
    ssoProvider: ["read"],
  });

  const { data: userCanUpdateOrganization } = useHasPermissions({
    organization: ["update"],
  });

  const { data: secretsType } = useSecretsType();

  const tabs = [
    { label: "LLM & MCP Gateways", href: "/settings/gateways" },
    { label: "Dual LLM", href: "/settings/dual-llm" },
    { label: "Chat", href: "/settings/chat" },
    { label: "Your Account", href: "/settings/account" },
    ...(userCanReadOrganization
      ? [
          { label: "Members", href: "/settings/members" },
          { label: "Teams", href: "/settings/teams" },
          { label: "Roles", href: "/settings/roles" },
          /**
           * SSO Providers tab is only shown when enterprise license is activated
           * and the user has the permission to read SSO providers.
           */
          ...(config.enterpriseLicenseActivated && userCanReadSsoProviders
            ? [{ label: "SSO Providers", href: "/settings/sso-providers" }]
            : []),
          { label: "Appearance", href: "/settings/appearance" },
        ]
      : []),
    /**
     * Secrets tab is only shown when using Vault storage (not DB)
     * and the user has permission to update organization settings.
     */
    ...(userCanUpdateOrganization && secretsType?.type === "Vault"
      ? [{ label: "Secrets", href: "/settings/secrets" }]
      : []),
  ];

  return (
    <PageLayout
      title="Settings"
      description="Manage your account settings and preferences"
      tabs={tabs}
    >
      {children}
    </PageLayout>
  );
}
