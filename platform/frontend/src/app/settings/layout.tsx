"use client";

import { DocsPage, getDocsUrl, SecretsManagerType } from "@archestra/shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { MessagingProvidersSubnav } from "@/components/messaging-channels/messaging-providers";
import { PageLayout } from "@/components/page-layout";
import { SectionNav } from "@/components/section-nav";
import { AppearanceSubnav } from "@/components/settings/appearance-navigation";
import {
  SettingsLayoutContext,
  type SettingsPageHeader,
} from "@/components/settings/settings-layout.context";
import {
  resolveSettingsSection,
  useSettingsTabs,
} from "@/components/settings/settings-tabs";
import { useDisableInvitations } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useSecretsType } from "@/lib/secrets.query";

const PAGE_CONFIG: Record<string, { title: string; description: ReactNode }> = {
  "/settings/service-accounts": {
    title: "Service Accounts",
    description:
      "Organization-owned identities for automation. Each service account has roles and its own API keys for the platform API.",
  },
  "/settings/oauth-clients": {
    title: "OAuth Clients",
    description:
      "Register applications for MCP Gateway, A2A, and LLM Proxy. One client can access several APIs, as itself or for signed-in users.",
  },
  "/settings/agents": {
    title: "Agents",
    description:
      "Defaults for agents and chats — default model, default agent, file uploads, and the channels agents can be reached through.",
  },
  "/settings/messaging-channels": {
    title: "Messaging Channels",
    description: "Connect chat apps and choose where each agent answers.",
  },
  "/settings/apps": {
    title: "Apps",
    description: "How apps behave when an agent creates one.",
  },
  "/settings/guardrails": {
    title: "Guardrails",
    description: <GuardrailsDescription />,
  },
  "/settings/credentials": {
    title: "Credentials",
    description: <CredentialsDescription />,
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
    title: "Connect Page",
    description:
      "Configure the connect page: which clients it offers, the defaults it pre-selects, and the base URLs it hands out.",
  },
  "/settings/llm": {
    title: "LLM",
    description: "Configure model providers and LLM proxy access.",
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
      "Authentication policies — token and session lifetimes, two-factor enforcement, and the default roles for new users.",
  },
  "/settings/roles": {
    title: "Roles",
    description: (
      <>
        Manage built-in and custom roles and what they allow. People who sign up
        with email and password, or join through ChatOps, get the default role.
        You can change it in{" "}
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

  // A record's own page (a role, say) is read and edited like any other
  // detail page: the content centred at the wizard width, with the back link
  // as the way out. The section list is for moving between settings pages,
  // and this is not one of them. Decided from the path, so the page does not
  // first draw with the list and then lose it.
  if (isSettingsRecordPath(pathname)) {
    return (
      <SettingsLayoutContext.Provider value={contextValue}>
        <PageLayout
          maxWidth="wizard"
          minWidth="phone"
          contentOverflowX="clip"
          title={pageHeader?.title ?? config.title}
          documentTitle={pageHeader?.documentTitle}
          description={pageHeader?.description}
          icon={pageHeader?.icon}
          backLink={pageHeader?.backLink}
          status={pageHeader?.status}
          tabs={pageHeader?.tabs}
          mobileVisibleCount={pageHeader?.tabs?.length}
          actionButton={actionButton}
        >
          {children}
        </PageLayout>
      </SettingsLayoutContext.Provider>
    );
  }

  return (
    <SettingsLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={pageHeader?.title ?? config.title}
        documentTitle={pageHeader?.documentTitle}
        description={pageHeader ? pageHeader.description : config.description}
        icon={pageHeader?.icon}
        backLink={pageHeader?.backLink}
        status={pageHeader?.status}
        tabs={pageHeader?.tabs}
        // Every tab stays on the row rather than collapsing into an overflow
        // popover: a record page here carries a handful of facets, not the
        // sixteen the section list holds.
        mobileVisibleCount={pageHeader?.tabs?.length}
        actionButton={actionButton}
      >
        {/* The section list sits beside the content rather than as a tab row
            above it: at sixteen entries the row scrolled sideways, so the
            settings you were not already looking at were off-screen. Below
            `lg` the row sits 8px under the header: PageLayout pads the content
            16px on phones and 24px from `sm`, so the pull-up follows suit. */}
        <div className="-mt-2 grid items-start gap-2 sm:-mt-4 lg:mt-0 lg:gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:rounded-lg scrollbar-sidebar">
            <SectionNav
              label="Settings sections"
              items={tabs.map((tab) =>
                tab.href === "/settings/messaging-channels"
                  ? { ...tab, subnav: <MessagingProvidersSubnav /> }
                  : tab.href === "/settings/appearance"
                    ? { ...tab, subnav: <AppearanceSubnav /> }
                    : tab,
              )}
              activeHref={sectionHref}
            />
          </div>
          <div className="min-w-0">{children}</div>
        </div>
      </PageLayout>
    </SettingsLayoutContext.Provider>
  );
}

/** The pages that stand for one record rather than for a settings section. */
function isSettingsRecordPath(pathname: string) {
  return SETTINGS_RECORD_PATHS.some((pattern) => pattern.test(pathname));
}

const SETTINGS_RECORD_PATHS = [/^\/settings\/roles\/[^/]+/];

function GuardrailsDescription() {
  const appName = useAppName();
  return (
    <>
      {`How ${appName} enforces your `}
      <ExternalDocsLink
        href="https://www.openappa.com"
        showIcon={false}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        OpenAPPA
      </ExternalDocsLink>{" "}
      policy on tool calls, and where the policy lives.
    </>
  );
}

function CredentialsDescription() {
  const { data: secretsType } = useSecretsType();
  return (
    <>
      Save credentials once and reuse them across agents, MCP servers, skills,
      and knowledge. Each user connects their own personal value; organization
      credentials share one value.{" "}
      {secretsType && (
        <span>
          {secretsType.type === SecretsManagerType.Vault
            ? "Values are stored in Vault. "
            : "Values are encrypted in the database. "}
        </span>
      )}
      <ExternalDocsLink href={getDocsUrl(DocsPage.PlatformCredentials)}>
        Learn more
      </ExternalDocsLink>
    </>
  );
}
