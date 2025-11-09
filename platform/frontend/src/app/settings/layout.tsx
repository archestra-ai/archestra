"use client";

import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth.query";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: userCanReadOrganization } = useHasPermissions({
    organization: ["read"],
  });

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
