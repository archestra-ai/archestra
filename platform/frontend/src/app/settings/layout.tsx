"use client";

import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth.query";
import { useFeatures } from "@/lib/features.query";

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

  const { data: features } = useFeatures();
  const isSsoEnabled = features?.sso ?? false;

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
          // SSO Providers tab is only shown when SSO feature is enabled
          ...(isSsoEnabled && userCanReadSsoProviders
            ? [{ label: "SSO Providers", href: "/settings/sso-providers" }]
            : []),
          { label: "Appearance", href: "/settings/appearance" },
        ]
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
