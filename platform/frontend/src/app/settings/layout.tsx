"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { useSettingsTabs } from "./settings-tabs";

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/settings/service-accounts": {
    title: "Service Accounts",
    description:
      "Organization-owned identities for automation. Each service account has a role and its own API keys for the platform API.",
  },
  "/settings/agents": {
    title: "Chat",
    description:
      "Defaults for chats and agents — default model, default agent, and file uploads.",
  },
  "/settings/security": {
    title: "Security",
    description:
      "Organization-wide security defaults for tools your agents use.",
  },
  "/settings/github": {
    title: "GitHub",
    description:
      "Manage organization GitHub credentials for connectors and skill sync.",
  },
  "/settings/environments": {
    title: "Environments",
    description:
      "Manage deployment environments — namespaces, network egress, and access. Environments also isolate which tools and knowledge agents and gateways can use, and scope cost limits.",
  },
  "/settings/identity-providers": {
    title: "Identity Providers",
    description:
      "Configure SSO, linked downstream IdPs, and identity provider integrations.",
  },
  "/settings/knowledge": {
    title: "Knowledge",
    description:
      "Configure embedding, reranking, and knowledge system defaults.",
  },
  "/settings/llm": {
    title: "LLM",
    description:
      "Configure platform-wide LLM behavior, like tool-result compression and default cost limits.",
  },
  "/settings/mcp": {
    title: "MCP",
    description: "Configure how MCP servers are added and managed.",
  },
  "/settings/skills": {
    title: "Skills",
    description: "Configure how skills are discovered and added.",
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

  const config = pathname.startsWith("/settings/service-accounts/")
    ? PAGE_CONFIG["/settings/service-accounts"]
    : (PAGE_CONFIG[pathname] ?? {
        title: "Settings",
        description: "Configure your platform, teams, and integrations.",
      });

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
