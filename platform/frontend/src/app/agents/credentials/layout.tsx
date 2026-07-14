"use client";

import { useMemo, useState } from "react";
import { CredentialsActionContext } from "@/components/credentials-action-context";
import { PageLayout } from "@/components/page-layout";

const TABS = [
  {
    label: "OAuth Clients",
    href: "/agents/credentials/oauth-clients",
  },
];

const PAGE_CONFIG: Record<string, { title: string; description: string }> = {
  "/agents/credentials/oauth-clients": {
    title: "OAuth Clients",
    description:
      "Register applications that authenticate to agents over A2A with OAuth — as an application (client credentials) or on behalf of users (authorization code)",
  },
};

export default function AgentCredentialsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [actionButton, setActionButton] = useState<React.ReactNode>(null);

  const config = PAGE_CONFIG["/agents/credentials/oauth-clients"];

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
