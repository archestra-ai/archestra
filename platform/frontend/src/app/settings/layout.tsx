"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { SectionNav } from "@/components/section-nav";
import { useDisableInvitations } from "@/lib/config/config.query";
import { resolveSettingsSection, useSettingsTabs } from "./settings-tabs";

const PAGE_CONFIG: Record<string, { title: string; description: ReactNode }> = {
  "/settings/service-accounts": {
    title: "Service Accounts",
    description:
      "Organization-owned identities for automation. Each service account has a role and its own API keys for the platform API.",
  },
  "/settings/oauth-clients": {
    title: "OAuth Clients",
    description:
      "Applications that authenticate with OAuth rather than a person signing in — to the LLM Proxy, or to your MCP gateways and agents. Each client is scoped to the resources it may reach.",
  },
  "/settings/agents": {
    title: "Agents",
    description:
      "Defaults for agents and chats — default model, default agent, file uploads, and the channels agents can be reached through.",
  },
  "/settings/messaging-channels": {
    title: "Messaging Channels",
    description:
      "Configure the providers that carry agent conversations. Channel-to-agent assignments are managed on each agent's page.",
  },
  "/settings/apps": {
    title: "Apps",
    description: "How apps behave when an agent creates one.",
  },
  "/settings/security": {
    title: "Security",
    description:
      "Organization-wide security defaults for tools your agents use.",
  },
  "/settings/github": {
    title: "GitHub",
    description:
      "Manage organization GitHub credentials for connectors, skill and plugin imports, recurring skill sync, and scheduled plugin checks.",
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
  "/settings/connection": {
    title: "Connection",
    description:
      "Configure the connect page: which clients it offers, the defaults it pre-selects, and the base URLs it hands out.",
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
  "/settings/appearance": {
    title: "Appearance",
    description:
      "Customize your organization's branding — logos, favicon, theme, and site-wide notifications.",
  },
  "/settings/auth": {
    title: "Auth",
    description:
      "Authentication policies — token and session lifetimes, two-factor enforcement, and the default role for new users.",
  },
  "/settings/roles": {
    title: "Roles",
    description: (
      <>
        Manage predefined and custom roles, permissions, and access control. New
        users who join via email/password self-signup or ChatOps
        auto-provisioning are assigned a default role. Change it in{" "}
        <Link
          href="/settings/auth"
          className="font-medium underline underline-offset-4"
        >
          Settings → Auth
        </Link>
        .
      </>
    ),
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
    description: <UsersDescription />,
  },
};

/**
 * The invitations half of this page only exists when the deployment allows
 * invitations at all (`ARCHESTRA_AUTH_DISABLE_INVITATIONS`), so the blurb
 * stops promising it when the tab and the invite button are hidden.
 */
function UsersDescription() {
  const disableInvitations = useDisableInvitations();
  return disableInvitations === false
    ? "Manage users, their roles, and user invitations."
    : "Manage users and their roles.";
}

export type SettingsPageHeader = {
  title: React.ReactNode;
  /** Browser tab title, when `title` is composed markup rather than a string. */
  documentTitle?: string;
  description?: React.ReactNode;
  backLink?: React.ReactNode;
  status?: React.ReactNode;
};

type SettingsLayoutContextType = {
  setActionButton: (node: React.ReactNode) => void;
  setPageHeader: (header: SettingsPageHeader | null) => void;
};

const SettingsLayoutContext = createContext<SettingsLayoutContextType>({
  setActionButton: () => {},
  setPageHeader: () => {},
});

export function useSetSettingsAction() {
  return useContext(SettingsLayoutContext).setActionButton;
}

/**
 * Lets a settings page replace the header this layout would otherwise derive
 * from the pathname. A record page needs to say *which* record you are on, and
 * `PAGE_CONFIG` is keyed by route, so without this the detail pages under
 * `/settings/*` inherit their list's title and never name their subject.
 *
 * Call it from an effect and clear it on unmount, the way `setActionButton` is
 * used, so the header does not outlive the page that set it.
 */
export function useSetSettingsPageHeader() {
  return useContext(SettingsLayoutContext).setPageHeader;
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const tabs = useSettingsTabs();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);
  const [pageHeader, setPageHeader] = useState<SettingsPageHeader | null>(null);

  // Route-derived default. A record page overrides it via `setPageHeader` once
  // it knows its subject; until then the prefix match keeps a detail page
  // under a section reading as that section rather than as bare "Settings".
  const sectionHref = resolveSettingsSection(pathname, tabs);
  const config = sectionHref
    ? (PAGE_CONFIG[sectionHref] ?? {
        title: "Settings",
        description: "Configure your platform, teams, and integrations.",
      })
    : {
        title: "Settings",
        description: "Configure your platform, teams, and integrations.",
      };

  const contextValue = useMemo(() => ({ setActionButton, setPageHeader }), []);

  return (
    <SettingsLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={pageHeader?.title ?? config.title}
        documentTitle={pageHeader?.documentTitle}
        description={pageHeader ? pageHeader.description : config.description}
        backLink={pageHeader?.backLink}
        status={pageHeader?.status}
        actionButton={actionButton}
      >
        {/* The section list sits beside the content rather than as a tab row
            above it: at sixteen entries the row scrolled sideways, so the
            settings you were not already looking at were off-screen. */}
        <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:rounded-lg scrollbar-sidebar">
            <SectionNav
              label="Settings sections"
              items={tabs}
              activeHref={sectionHref}
            />
          </div>
          <div className="min-w-0">{children}</div>
        </div>
      </PageLayout>
    </SettingsLayoutContext.Provider>
  );
}
