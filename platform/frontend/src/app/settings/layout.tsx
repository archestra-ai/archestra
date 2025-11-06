"use client";

import { PageLayout } from "@/components/page-layout";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tabs = [
    { label: "LLM & MCP Gateways", href: "/settings/gateways" },
    { label: "Dual LLM", href: "/settings/dual-llm" },
    { label: "Your Account", href: "/settings/account" },
    ...(hasPermissionTODO
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
