"use client";

import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { CredentialsActionContext } from "@/components/credentials-action-context";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "OAuth Clients",
    href: "/credentials/oauth-clients",
  },
  {
    label: "Virtual Keys",
    href: "/credentials/virtual-keys",
  },
];

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/credentials/oauth-clients": {
    title: "OAuth Clients",
    description:
      "Register applications that authenticate to your agents, MCP gateways, and LLM proxies with OAuth — as an application (client credentials) or on behalf of users (authorization code)",
  },
  "/credentials/virtual-keys": {
    title: "Virtual Keys",
    description:
      "Issue virtual API keys that authenticate to the LLM proxy and map to your provider credentials",
  },
};

export default function CredentialsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG[pathname] ?? {
    title: "Credentials",
    description: "",
  };

  const contextValue = useMemo(() => ({ setActionButton }), []);

  return (
    <CredentialsActionContext.Provider value={contextValue}>
      <PageLayout
        title={config.title}
        description={config.description}
        tabs={TABS}
        actionButton={actionButton}
      >
        {children}
      </PageLayout>
    </CredentialsActionContext.Provider>
  );
}
