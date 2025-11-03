"use client";

import { PageLayout } from "@/components/page-layout";
import { useRole } from "@/lib/auth.hook";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const role = useRole();
  const showAdminTabs = role === "admin";

  const tabs = [
    { label: "LLM & MCP Gateways", href: "/settings/gateways" },
    { label: "Dual LLM", href: "/settings/dual-llm" },
    { label: "Your Account", href: "/settings/account" },
    ...(showAdminTabs
      ? [
          { label: "Members", href: "/settings/members" },
          { label: "Teams", href: "/settings/teams" },
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
