"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { useSettingsTabs } from "./settings-tabs";

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/settings/account": {
    title: "Your Account",
    description:
      "Manage your personal profile, sessions, and sign-in settings.",
  },
  "/settings/api-keys": {
    title: "API Keys",
    description: "Create and manage personal API keys for programmatic access.",
  },
  "/settings/agents": {
    title: "Agents",
    description:
      "Configure default agent behavior and agent-related platform settings.",
  },
  "/settings/identity-providers": {
    title: "Identity Providers",
    description: "Configure SSO and identity provider integrations.",
  },
  "/settings/knowledge": {
    title: "Knowledge",
    description:
      "Configure embedding, reranking, and knowledge system defaults.",
  },
  "/settings/llm": {
    title: "LLM",
    description: "Configure platform-wide LLM defaults and behavior.",
  },
  "/settings/organization": {
    title: "Organization",
    description:
      "Manage organization-wide appearance and authentication settings",
  },
  "/settings/roles": {
    title: "Roles",
    description:
      "Manage predefined and custom roles, permissions, and access control.",
  },
  "/settings/secrets": {
    title: "Secrets",
    description: "Manage organization secrets and secure configuration.",
  },
  "/settings/teams": {
    title: "Teams",
    description:
      "Manage teams and their access to resources across the platform.",
  },
  "/settings/users": {
    title: "Users",
    description: "Manage users, their roles, and user invitations.",
  },
};

type SettingsLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const SettingsLayoutContext = createContext<SettingsLayoutContextType>({
  setActionButton: () => {},
});

export function useSetSettingsAction() {
  return useContext(SettingsLayoutContext).setActionButton;
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const tabs = useSettingsTabs();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG[pathname] ?? {
    title: "Settings",
    description: "Configure your platform, teams, and integrations.",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <SettingsLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={tabs}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </SettingsLayoutContext.Provider>
  );
}
